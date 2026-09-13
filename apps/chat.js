import { generateText, tool, isStepCount } from 'ai'
import { z } from 'zod'
import Config from '../config/config.js'
import { getModel } from '../models/provider.js'
import { getHistory, historyKey, pushHistory } from '../models/history.js'
import { generateImageBase64, collectEventImages, toImageSegment } from '../models/image.js'
import { buildListText, fetchWallpaperBuffer, getWallpaperOriginalUrls, getWallpaperPage } from '../models/wallpaper.js'

/** 从事件消息中提取触发文本（统一剥离触发前缀，at 模式下用前缀触发同样剥离） */
function extractUserText (e) {
  let text = (e.msg || '').trim()
  if (Config.togglePrefix && text.startsWith(Config.togglePrefix)) {
    text = text.slice(Config.togglePrefix.length).trim()
  }
  return text
}

/** 根据 URL 猜测图片 mediaType（猜不出按 png 处理） */
function guessImageMediaType (url) {
  const s = String(url).toLowerCase()
  if (s.includes('.png')) return 'image/png'
  if (s.includes('.jpg') || s.includes('.jpeg')) return 'image/jpeg'
  if (s.includes('.webp')) return 'image/webp'
  if (s.includes('.gif')) return 'image/gif'
  return 'image/png'
}

/** 构建用户消息内容：带图片时使用 file content part（ai 7 已弃用 image part），否则使用纯文本 */
function buildUserContent (images, text) {
  if (images.length > 0) {
    const content = images.map(url => ({
      type: 'file',
      mediaType: guessImageMediaType(url),
      data: { type: 'url', url }
    }))
    content.push({ type: 'text', text: text || '请描述这张图片' })
    return content
  }
  return text
}

/** @机器人时是否指向本 bot（兼容 Bot.uin 为数组或字符串的适配器） */
function atMe (e) {
  if (e.atBot) return true
  if (e.at === undefined || e.at === null) return false
  if (Array.isArray(Bot.uin)) return Bot.uin.map(String).includes(String(e.at))
  return String(e.at) === String(Bot.uin)
}

/** 是否触发对话 */
function triggered (e) {
  const msg = (e.msg || '').trim()
  // 私聊始终响应（私聊无法 @，等价于一直对话）
  if (!e.isGroup) return true
  if (Config.toggleMode === 'prefix') {
    return msg.startsWith(Config.togglePrefix)
  }
  // at 模式：@机器人触发，也允许直接用前缀触发
  return atMe(e) || msg.startsWith(Config.togglePrefix)
}

export class Chat extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin对话',
      dsc: '基于 Vercel AI SDK 的对话',
      event: 'message',
      priority: 555500,
      rule: [
        {
          reg: '^[^#]?[sS]*',
          fnc: 'chat',
          log: false
        }
      ]
    })
  }

  async chat (e) {
    if (!triggered(e)) {
      return false
    }
    if (!Config.apiKey) {
      logger.warn('[chatgpt-plugin] 已触发对话但尚未配置 apiKey，请编辑 config/config.yaml 或使用锅巴配置')
      await e.reply('chatgpt-plugin 尚未配置 apiKey，请联系主人在 config/config.yaml 或锅巴中配置~')
      return false
    }
    const userText = extractUserText(e)
    const userImages = collectEventImages(e)
    if (!userText && userImages.length === 0) {
      return false
    }
    const key = historyKey(e)
    const cfg = Config.snapshot()
    const messages = [...getHistory(key)]
    messages.push({ role: 'user', content: buildUserContent(userImages, userText) })

    logger.info(`[chatgpt-plugin] 进入对话: ${userText}`)
    try {
      // 图片生成/编辑作为 agent 工具：开启后模型可在对话中自主调用画图
      const pendingImages = []
      const imageEnabled = !!cfg.image?.model
      const tools = imageEnabled && cfg.image?.asTool !== false
        ? {
            generate_image: tool({
              description: '生成一张新图片，或对参考图片进行编辑修改并产出新图片（重绘、改风格、改背景、P图）。仅当用户想要"产出图片"时才调用本工具；用户只是发图片让你识别、描述、分析或回答问题时，不要调用本工具，直接回答即可。调用后图片会直接发送给用户。编辑用户当前消息中的图片时不要传 imageUrls，工具会自动使用用户发送的图片；imageUrls 仅在图片地址确实出现在当前对话上下文中时才提供。',
              inputSchema: z.object({
                prompt: z.string().describe('对目标图片的文字描述'),
                // nullable：部分 provider 会给未提供的可选字段传 null 而不是省略
                imageUrls: z.array(z.string()).nullable().optional().describe('可选：参考图片 URL。仅当 URL 来自当前对话中真实出现过的图片时才填写')
              }),
              execute: async ({ prompt: imagePrompt, imageUrls }) => {
                try {
                  // 只信任用户当前消息里真实存在的图片；
                  // 模型幻觉出来的 URL（下载必然 403）一律忽略
                  const requested = (imageUrls ?? []).filter(url => userImages.includes(url))
                  const useImages = requested.length > 0 ? requested : userImages
                  if ((imageUrls?.length ?? 0) > requested.length) {
                    logger.warn('[chatgpt-plugin] 已忽略模型提供的未知/无效图片 URL，改用用户消息中的图片')
                  }
                  logger.info(`[chatgpt-plugin] agent 图片工具开始执行（参考图 ${useImages.length} 张）: ${imagePrompt}`)
                  const base64 = await generateImageBase64({ prompt: imagePrompt, images: useImages })
                  logger.info(`[chatgpt-plugin] agent 图片工具执行完成，图片约 ${Math.round(base64.length * 3 / 4 / 1024)} KB，立即发送`)
                  // 拿到图片立即发送，不等待对话收尾（后续步骤卡住/超时都不会吞图）
                  try {
                    const buffer = Buffer.from(base64, 'base64')
                    await e.reply(await toImageSegment(buffer))
                    toolSentContent = true
                    return useImages.length > 0
                      ? `已基于用户的 ${useImages.length} 张图片完成编辑，图片已发送给用户。请再用一句话简短说明即可，不要重复发图。`
                      : '图片已生成并发送给用户。请再用一句话简短说明即可，不要重复发图。'
                  } catch (sendErr) {
                    // 即时发送失败则记录，等 generateText 结束后重试
                    pendingImages.push(base64)
                    logger.error(`[chatgpt-plugin] 图片即时发送失败，将在对话结束后重试: ${sendErr?.message || sendErr}`)
                    return '图片已生成完毕。'
                  }
                } catch (err) {
                  logger.error(`[chatgpt-plugin] agent 图片工具执行失败: ${err?.message || err}`)
                  return `图片生成失败：${err?.message || err}`
                }
              }
            })
          }
        : undefined

      // 壁纸工具：列表 / 直接把原图发给用户
      let toolSentContent = false
      const wallpaperEnabled = cfg.wallpaper?.enable !== false && !!cfg.wallpaper
      const wallpaperTool = wallpaperEnabled
        ? {
            get_wallpaper: tool({
              description: '获取最新壁纸，或把壁纸原图直接发送给用户。indexes 是全局编号（预览图/列表上显示的编号，1 = 最新一张，自动跨页，无需关心页码）。用户指定编号要某张壁纸时（如"发第25张壁纸"），直接用 action=download + indexes=[25] 发送原图，不要先 list，也不要把编号换算成页码。action=list 仅在用户想浏览/挑选时使用。发送给用户的一定是原图（高清大图），不是缩略图。',
              inputSchema: z.object({
                action: z.enum(['list', 'download']).describe('list：查看某页壁纸列表；download：发送指定编号的壁纸原图'),
                // nullable：部分 provider 会给未提供的可选字段传 null 而不是省略
                page: z.number().int().min(1).nullable().optional().describe('action=list 时的页码，默认 1（最新）'),
                indexes: z.array(z.number().int().min(1)).nullable().optional().describe('action=download 时必填：全局编号列表，如 [25] 或 [1,2]')
              }),
              execute: async ({ action, page, indexes }) => {
                try {
                  if (action === 'download') {
                    const urls = await getWallpaperOriginalUrls(indexes ?? [])
                    for (const url of urls) {
                      const buffer = await fetchWallpaperBuffer(url)
                      await e.reply(await toImageSegment(buffer))
                    }
                    toolSentContent = true
                    return `已把编号 [${(indexes ?? []).join(',')}] 的 ${urls.length} 张壁纸原图发送给用户。`
                  }
                  return `已获取列表，请把编号展示给用户并询问想下载哪张（用户报编号后用 action=download 发送原图）：\n${buildListText(wallpaperPage)}`
                } catch (err) {
                  logger.error(`[chatgpt-plugin] agent 壁纸工具执行失败: ${err?.message || err}`)
                  return `壁纸获取失败：${err?.message || err}`
                }
              }
            })
          }
        : undefined
      const allTools = { ...(tools ?? {}), ...(wallpaperTool ?? {}) }
      const hasTools = Object.keys(allTools).length > 0

      // agent 模式下图片生成可能耗时数分钟（图片接口有独立超时预算），
      // 整体超时需相应放宽：对话超时 + 2 次图片预算 + 缓冲
      const imageToolActive = imageEnabled && cfg.image?.asTool !== false
      const imageTimeout = imageToolActive ? (cfg.image?.timeout ?? 180000) : 0
      const overallTimeout = hasTools
        ? (cfg.timeout || 120000) + imageTimeout * 2 + 60000
        : (cfg.timeout || 120000)

      // 弱模型容易"嘴上完成、实际不调工具"，用系统提示强制约束；
      // 同时明确识图/问答走模型自身视觉能力，不要误触发工具
      const toolNames = Object.keys(allTools)
      const toolRule = []
      if (imageToolActive) {
        toolRule.push('当用户要求"生成、画、创作"一张新图片，或对已有图片进行"编辑、重绘、改风格、改背景、P图"等修改并产出新图片时，你必须调用 generate_image 工具来完成；在未调用工具之前，严禁声称图片已生成、已完成，或描述"生成的"图片内容。')
      }
      if (wallpaperEnabled) {
        toolRule.push('当用户想要壁纸、美图时，使用 get_wallpaper 工具获取列表或直接发送原图。')
      }
      const toolSystemRule = toolRule.length > 0
        ? `\n\n[工具规则] ${toolRule.join('')}注意区分：用户仅仅发图片让你看图、识别、描述、分析、回答问题时，这是你自带的视觉能力，不要调用工具，直接基于看到的图片回答。图片类工具会把图片直接发送给用户，你只需在工具成功后用一句话简短确认。`
        : ''
      const systemPrompt = ((cfg.systemPrompt || '') + toolSystemRule).trim() || undefined

      let text = ''
      let chatError = null
      try {
        ;({ text } = await generateText({
          model: getModel(cfg.model),
          system: systemPrompt,
          messages,
          tools: hasTools ? allTools : undefined,
          toolChoice: hasTools ? 'auto' : undefined,
          stopWhen: hasTools ? isStepCount(5) : undefined,
          maxOutputTokens: cfg.maxTokens > 0 ? cfg.maxTokens : undefined,
          temperature: cfg.temperature >= 0 ? cfg.temperature : undefined,
          abortSignal: AbortSignal.timeout(overallTimeout)
        }))
      } catch (err) {
        chatError = err
      }

      // 图片已生成的先发出来（即使整体超时/失败也不丢图）
      for (const base64 of pendingImages) {
        await e.reply(await toImageSegment(Buffer.from(base64, 'base64')))
      }

      if (chatError) {
        if (pendingImages.length > 0) {
          // 超时等情况下工具可能已完成，不能把已生成的图片吞掉
          logger.warn(`[chatgpt-plugin] 对话异常但已生成 ${pendingImages.length} 张图片，已发送: ${chatError?.message || chatError}`)
        } else {
          throw chatError
        }
      }
      if (text) {
        // 历史中只保留纯文本，避免图片 URL 膨胀
        pushHistory(key, { role: 'user', content: userText || '[图片]' })
        pushHistory(key, { role: 'assistant', content: text })
        await e.reply(text)
      }
      // 工具已直接发送过图片时，模型收尾没有文字是正常情况，不要再补报错
      if (!text && !toolSentContent && pendingImages.length === 0 && !chatError) {
        await e.reply('模型没有返回内容')
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 对话失败: ${err?.message || err}`)
      await e.reply(`对话出错了：${err?.message || err}`)
    }
    return true
  }
}
