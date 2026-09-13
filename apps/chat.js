import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import Config from '../config/config.js'
import { getModel } from '../models/provider.js'
import { getHistory, historyKey, pushHistory } from '../models/history.js'
import { generateImageBase64, collectEventImages } from '../models/image.js'

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
              description: '生成一张图片，或在用户发送了图片时基于该图片进行编辑（如重绘、改风格、改背景）。编辑用户当前消息中的图片时不要传 imageUrls，工具会自动使用用户发送的图片；imageUrls 仅在图片地址确实出现在当前对话上下文中时才提供。',
              inputSchema: z.object({
                prompt: z.string().describe('对目标图片的文字描述'),
                imageUrls: z.array(z.string()).optional().describe('可选：参考图片 URL。仅当 URL 来自当前对话中真实出现过的图片时才填写')
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
                    await e.reply(global.segment?.image ? segment.image(buffer) : buffer)
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

      // agent 模式下图片生成可能耗时数分钟（图片接口有独立超时预算），
      // 整体超时需相应放宽：对话超时 + 2 次图片预算 + 缓冲
      const useTools = imageEnabled && cfg.image?.asTool !== false
      const imageTimeout = useTools ? (cfg.image?.timeout ?? 180000) : 0
      const overallTimeout = useTools
        ? (cfg.timeout || 120000) + imageTimeout * 2 + 60000
        : (cfg.timeout || 120000)

      let text = ''
      let chatError = null
      try {
        ;({ text } = await generateText({
          model: getModel(cfg.model),
          system: cfg.systemPrompt || undefined,
          messages,
          tools,
          stopWhen: tools ? stepCountIs(5) : undefined,
          maxOutputTokens: cfg.maxTokens > 0 ? cfg.maxTokens : undefined,
          temperature: cfg.temperature >= 0 ? cfg.temperature : undefined,
          abortSignal: AbortSignal.timeout(overallTimeout)
        }))
      } catch (err) {
        chatError = err
      }

      // 图片已生成的先发出来（即使整体超时/失败也不丢图）
      for (const base64 of pendingImages) {
        const buffer = Buffer.from(base64, 'base64')
        if (global.segment?.image) {
          await e.reply(segment.image(buffer))
        } else {
          await e.reply(buffer)
        }
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
      if (!text && pendingImages.length === 0 && !chatError) {
        await e.reply('模型没有返回内容')
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 对话失败: ${err?.message || err}`)
      await e.reply(`对话出错了：${err?.message || err}`)
    }
    return true
  }
}
