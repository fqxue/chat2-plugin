import { generateText, tool, isStepCount, hasToolCall } from 'ai'
import { z } from 'zod'
import Config from '../config/config.js'
import { getModel } from '../models/provider.js'
import { getHistory, historyKey, pushHistory } from '../models/history.js'
import { generateImageBase64, collectEventImages, replyImage, resolveImages } from '../models/image.js'
import { fetchWallpaperBuffer, getWallpaperOriginalUrls, getWallpaperPage, buildPreviewHtml } from '../models/wallpaper.js'
import { renderHtmlToImage } from '../models/render.js'

/** 从事件消息中提取触发文本（统一剥离触发前缀，at 模式下用前缀触发同样剥离） */
function extractUserText (e) {
  let text = (e.msg || '').trim()
  if (Config.togglePrefix && text.startsWith(Config.togglePrefix)) {
    text = text.slice(Config.togglePrefix.length).trim()
  }
  return text
}

/** 构建用户消息内容：带图片时使用 file content part（ai 7 已弃用 image part），否则使用纯文本 */
async function buildUserContent (images, text) {
  if (images.length > 0) {
    const resolvedImages = await resolveImages(images)
    const content = resolvedImages.map(url => ({
      type: 'file',
      mediaType: 'image',
      data: { type: 'url', url: new URL(url) }
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
  const botUin = global.Bot?.uin
  if (botUin === undefined || botUin === null) return false
  if (Array.isArray(botUin)) return botUin.map(String).includes(String(e.at))
  return String(e.at) === String(botUin)
}

/** 工具入参 schema：保持简单、明确，减少弱模型生成无效参数的概率 */
const imageToolSchema = z.object({
  prompt: z.string().trim().min(1).describe('要生成的图片描述，或对用户当前图片的编辑指令')
})

const wallpaperListToolSchema = z.object({
  page: z.number().int().min(1).optional().describe('要浏览的页码，默认 1（最新）')
})

const wallpaperDownloadToolSchema = z.object({
  indexes: z.array(z.number().int().min(1)).min(1).max(9)
    .describe('要发送的壁纸全局编号，如 [25] 或 [1,2]')
})

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

// 已提示过 apiKey 未配置的会话，避免私聊每条消息都刷警告
const apiKeyWarned = new Set()

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
      const key = historyKey(e)
      if (!apiKeyWarned.has(key)) {
        apiKeyWarned.add(key)
        logger.warn('[chatgpt-plugin] 已触发对话但尚未配置 apiKey，请编辑 config/config.yaml 或使用锅巴配置')
        await e.reply('chatgpt-plugin 尚未配置 apiKey，请联系主人在 config/config.yaml 或锅巴中配置~')
      }
      return false
    }
    apiKeyWarned.delete(historyKey(e))
    const userText = extractUserText(e)
    const userImages = collectEventImages(e)
    if (!userText && userImages.length === 0) {
      return false
    }
    const key = historyKey(e)
    const cfg = Config.snapshot()
    const messages = [...getHistory(key)]
    messages.push({ role: 'user', content: await buildUserContent(userImages, userText) })

    logger.info(`[chatgpt-plugin] 进入对话: ${userText}`)
    try {
      // 这些工具直接向聊天发送内容，成功后不再进行模型收尾请求
      let toolSentContent = false
      const toolHistory = []
      let lastToolError = ''
      const imageEnabled = !!cfg.image?.model
      const allTools = {}
      if (imageEnabled && cfg.image?.asTool !== false) {
        allTools.generate_image = tool({
          description: '生成新图片，或编辑用户当前消息附带/引用的图片。仅在用户要求产出图片时调用；识图、描述、分析和问答直接使用模型视觉能力。参考图由插件自动读取，不需要也不能提供图片 URL。工具成功后会直接把图片发送给用户。',
          inputSchema: imageToolSchema,
          execute: async ({ prompt: imagePrompt }) => {
            try {
              logger.info(`[chatgpt-plugin] agent 图片工具开始执行（参考图 ${userImages.length} 张）: ${imagePrompt}`)
              const base64 = await generateImageBase64({ prompt: imagePrompt, images: userImages })
              logger.info(`[chatgpt-plugin] agent 图片工具执行完成，图片约 ${Math.round(base64.length * 3 / 4 / 1024)} KB，立即发送`)
              await replyImage(e, Buffer.from(base64, 'base64'))
              toolSentContent = true
              toolHistory.push(userImages.length > 0
                ? `[已编辑并发送图片，参考图 ${userImages.length} 张]`
                : '[已生成并发送图片]')
              return {
                delivered: true,
                type: userImages.length > 0 ? 'edited-image' : 'generated-image',
                referenceImageCount: userImages.length
              }
            } catch (err) {
              lastToolError = `图片生成失败：${err?.message || err}`
              logger.error(`[chatgpt-plugin] agent 图片工具执行失败: ${err?.message || err}`)
              throw err
            }
          }
        })
      }

      // 浏览和下载是两个不同动作，拆开后每个 schema 都没有条件必填字段
      const wallpaperEnabled = cfg.wallpaper?.enable !== false && !!cfg.wallpaper
      if (wallpaperEnabled) {
        allTools.list_wallpapers = tool({
          description: '发送一页最新壁纸预览图，供用户浏览和挑选。用户已指定壁纸编号时不要调用本工具，应直接调用 download_wallpapers。',
          inputSchema: wallpaperListToolSchema,
          execute: async ({ page = 1 }) => {
            try {
              const wallpaperPage = await getWallpaperPage(page)
              const html = await buildPreviewHtml(wallpaperPage)
              const preview = await renderHtmlToImage(html, `chatgpt-wallpaper-page-${wallpaperPage.page}`)
              if (!preview) throw new Error('壁纸预览生成失败，请稍后重试')
              await replyImage(e, preview, 'chatgpt-wallpaper.jpg')
              toolSentContent = true
              toolHistory.push(`[已发送第 ${wallpaperPage.page} 页壁纸预览]`)
              return { delivered: true, type: 'wallpaper-preview', page: wallpaperPage.page }
            } catch (err) {
              lastToolError = `壁纸获取失败：${err?.message || err}`
              logger.error(`[chatgpt-plugin] agent 壁纸预览工具执行失败: ${err?.message || err}`)
              throw err
            }
          }
        })
        allTools.download_wallpapers = tool({
          description: '按全局编号把壁纸原图直接发送给用户。编号来自预览图，1 表示最新一张且自动跨页。用户给出编号时直接调用，不要先浏览或换算页码。',
          inputSchema: wallpaperDownloadToolSchema,
          execute: async ({ indexes }) => {
            try {
              const urls = await getWallpaperOriginalUrls(indexes)
              for (const url of urls) {
                await replyImage(e, await fetchWallpaperBuffer(url))
              }
              toolSentContent = true
              toolHistory.push(`[已发送壁纸原图：${indexes.join(', ')}]`)
              return { delivered: true, type: 'wallpaper-originals', indexes, count: urls.length }
            } catch (err) {
              lastToolError = `壁纸下载失败：${err?.message || err}`
              logger.error(`[chatgpt-plugin] agent 壁纸下载工具执行失败: ${err?.message || err}`)
              throw err
            }
          }
        })
      }
      const hasTools = Object.keys(allTools).length > 0

      // agent 模式下图片生成可能耗时数分钟（图片接口有独立超时预算），
      // 整体超时需相应放宽：对话超时 + 一次图片工具预算 + 缓冲
      const imageToolActive = imageEnabled && cfg.image?.asTool !== false
      const configuredImageTimeout = Number(cfg.image?.timeout)
      const imageTimeout = imageToolActive
        ? (Number.isFinite(configuredImageTimeout) && configuredImageTimeout > 0
            ? Math.min(Math.floor(configuredImageTimeout), 30 * 60 * 1000)
            : 180000)
        : 0
      const baseTimeout = Number.isFinite(Number(cfg.timeout)) && Number(cfg.timeout) > 0
        ? Math.min(Math.floor(Number(cfg.timeout)), 30 * 60 * 1000)
        : 120000
      const overallTimeout = hasTools
        ? baseTimeout + imageTimeout + 60000
        : baseTimeout

      // 弱模型容易"嘴上完成、实际不调工具"，用系统提示强制约束；
      // 同时明确识图/问答走模型自身视觉能力，不要误触发工具
      const toolRule = []
      if (imageToolActive) {
        toolRule.push('当用户要求"生成、画、创作"一张新图片，或对已有图片进行"编辑、重绘、改风格、改背景、P图"等修改并产出新图片时，你必须调用 generate_image 工具来完成；在未调用工具之前，严禁声称图片已生成、已完成，或描述"生成的"图片内容。')
      }
      if (wallpaperEnabled) {
        toolRule.push('当用户想浏览壁纸时调用 list_wallpapers；用户给出编号索要壁纸时直接调用 download_wallpapers，不能先调用列表工具。')
      }
      const toolSystemRule = toolRule.length > 0
        ? `\n\n[工具规则] ${toolRule.join('')}注意区分：用户仅仅发图片让你看图、识别、描述、分析、回答问题时，这是你自带的视觉能力，不要调用工具，直接基于看到的图片回答。工具会直接把结果发送给用户，调用成功后不需要再生成确认文字。`
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
          stopWhen: hasTools
            ? [isStepCount(3), hasToolCall('generate_image', 'list_wallpapers', 'download_wallpapers')]
            : undefined,
          maxOutputTokens: cfg.maxTokens > 0 ? cfg.maxTokens : undefined,
          temperature: cfg.temperature >= 0 ? cfg.temperature : undefined,
          abortSignal: AbortSignal.timeout(overallTimeout)
        }))
      } catch (err) {
        chatError = err
      }

      if (chatError) {
        if (toolSentContent) {
          logger.warn(`[chatgpt-plugin] 工具结果已发送，忽略后续 SDK 错误: ${chatError?.message || chatError}`)
        } else if (lastToolError) {
          logger.warn(`[chatgpt-plugin] 工具执行失败后 SDK 又返回错误，优先回复工具错误: ${chatError?.message || chatError}`)
        } else {
          throw chatError
        }
      }
      if (lastToolError) {
        pushHistory(key, { role: 'user', content: userText || '[图片]' })
        pushHistory(key, { role: 'assistant', content: lastToolError })
        await e.reply(lastToolError)
      } else if (toolSentContent) {
        // 副作用工具的结果就是本轮最终响应，不发送模型同一步产生的铺垫文字
        pushHistory(key, { role: 'user', content: userText || '[图片]' })
        pushHistory(key, { role: 'assistant', content: toolHistory.join('\n') || '[工具结果已发送]' })
      } else if (text) {
        // 历史中只保留纯文本，避免图片 URL 膨胀
        pushHistory(key, { role: 'user', content: userText || '[图片]' })
        pushHistory(key, { role: 'assistant', content: text })
        await e.reply(text)
      } else if (!chatError) {
        await e.reply(lastToolError || '模型没有返回内容')
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 对话失败: ${err?.message || err}`)
      await e.reply(`对话出错了：${err?.message || err}`)
    }
    return true
  }
}
