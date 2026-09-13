import { generateText } from 'ai'
import Config from '../config/config.js'
import { getModel } from '../models/provider.js'
import { getHistory, historyKey, pushHistory } from '../models/history.js'

/** 从事件消息中提取触发文本 */
function extractUserText (e) {
  let text = (e.msg || '').trim()
  if (Config.toggleMode === 'prefix' && text.startsWith(Config.togglePrefix)) {
    text = text.slice(Config.togglePrefix.length).trim()
  }
  return text
}

/** 构建用户消息内容：带图片时使用多模态 content，否则使用纯文本 */
function buildUserContent (e, text) {
  const images = Array.isArray(e.img) ? e.img : []
  if (images.length > 0) {
    const content = images.map(url => ({ type: 'image', image: url }))
    content.push({ type: 'text', text: text || '请描述这张图片' })
    return content
  }
  return text
}

/** 是否触发对话 */
function triggered (e) {
  const msg = e.msg || ''
  if (Config.toggleMode === 'prefix') {
    return msg.startsWith(Config.togglePrefix)
  }
  // at 模式：@机器人触发，也允许直接用前缀触发
  return !!(e.atBot || e.at === Bot.uin) || msg.startsWith(Config.togglePrefix)
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
    if (!Config.apiKey || !triggered(e)) {
      return false
    }
    const userText = extractUserText(e)
    if (!userText && !e.img?.length) {
      return false
    }
    const key = historyKey(e)
    const cfg = Config.snapshot()
    const messages = [...getHistory(key)]
    messages.push({ role: 'user', content: buildUserContent(e, userText) })

    logger.info(`[chatgpt-plugin] 进入对话: ${userText}`)
    try {
      const { text } = await generateText({
        model: getModel(cfg.model),
        system: cfg.systemPrompt || undefined,
        messages,
        maxOutputTokens: cfg.maxTokens > 0 ? cfg.maxTokens : undefined,
        temperature: cfg.temperature >= 0 ? cfg.temperature : undefined,
        abortSignal: AbortSignal.timeout(cfg.timeout || 120000)
      })
      if (!text) {
        await e.reply('模型没有返回内容')
        return true
      }
      // 历史中只保留纯文本，避免图片 URL 膨胀
      pushHistory(key, { role: 'user', content: userText || '[图片]' })
      pushHistory(key, { role: 'assistant', content: text })
      await e.reply(text)
    } catch (err) {
      logger.error(`[chatgpt-plugin] 对话失败: ${err?.message || err}`)
      await e.reply(`对话出错了：${err?.message || err}`)
    }
    return true
  }
}
