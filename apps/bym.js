import { generateText } from 'ai'
import Config from '../config/config.js'
import { getModel } from '../models/provider.js'
import { getRecentGroupMessages } from '../models/groupLog.js'

/** 是否触发伪人发言 */
function shouldTrigger (e) {
  const bym = Config.bym
  if (!bym?.enable || !e.isGroup) return false
  const msg = (e.msg || '').trim()
  if (!msg || msg.startsWith('#')) return false
  // 不响应机器人自己的消息，避免自问自答
  if (e.user_id === Bot.uin) return false
  // 必中关键词，否则按概率随机触发
  if (Array.isArray(bym.hit) && bym.hit.some(word => word && msg.includes(word))) {
    return true
  }
  return Math.random() < (bym.probability ?? 0)
}

export class Bym extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin伪人模式',
      dsc: '概率触发的拟人群聊发言',
      event: 'message',
      // 低于普通对话（555500），普通对话优先响应
      priority: 555600,
      rule: [
        { reg: '^[sS]*', fnc: 'bym', log: false }
      ]
    })
  }

  async bym (e) {
    if (!shouldTrigger(e)) {
      return false
    }
    const bym = Config.bym
    const cfg = Config.snapshot()
    if (!cfg.apiKey) {
      return false
    }

    // reply 模式：把触发消息原样交给模型回复；
    // contextual 模式：注入最近群聊记录 + 自主发言指令
    let prompt
    if (bym.speakingMode === 'contextual') {
      const recent = getRecentGroupMessages(e.group_id, bym.contextLength ?? 20)
      if (recent.length === 0) {
        return false
      }
      const transcript = recent.map(m => `${m.sender}（${m.time}）：${m.text}`).join('\n')
      prompt = `${bym.contextualPrompt}\n\n最近的群聊消息：\n${transcript}`
    } else {
      prompt = e.msg
    }

    logger.info(`[chatgpt-plugin] 伪人模式触发 (${bym.speakingMode}): ${e.msg}`)
    try {
      const { text } = await generateText({
        model: getModel(cfg.model),
        system: bym.systemPrompt || undefined,
        prompt,
        maxOutputTokens: bym.maxTokens > 0 ? bym.maxTokens : undefined,
        temperature: bym.temperature >= 0 ? bym.temperature : undefined,
        abortSignal: AbortSignal.timeout(cfg.timeout || 120000)
      })
      if (text) {
        // reply 模式引用触发消息；contextual 模式自然插话不引用
        await e.reply(text, bym.speakingMode !== 'contextual')
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 伪人模式发言失败: ${err?.message || err}`)
    }
    // 始终返回 false，不影响其他插件继续处理该消息
    return false
  }
}
