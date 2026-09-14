import Config from '../config/config.js'
import { recordGroupMessage } from '../models/groupLog.js'

/**
 * 群聊消息记录器：在伪人模式（BYM）开启且为 contextual 策略时，
 * 记录每个群最近的消息，供伪人发言时作为上下文注入。
 * 永远 return false，不阻断其他插件处理。
 */
export class Recorder extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin群聊记录',
      dsc: '记录群聊消息用于伪人模式上下文',
      event: 'message',
      priority: 10,
      rule: [
        { reg: '^[sS]*', fnc: 'record', log: false }
      ]
    })
  }

  async record (e) {
    const bym = Config.bym
    const botUin = global.Bot?.uin
    const isSelf = botUin !== undefined && botUin !== null &&
      (Array.isArray(botUin) ? botUin.map(String).includes(String(e.user_id)) : String(e.user_id) === String(botUin))
    if (bym?.enable && bym?.speakingMode === 'contextual' && e.isGroup && !isSelf) {
      recordGroupMessage(e)
    }
    return false
  }
}
