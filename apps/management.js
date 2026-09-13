import Config from '../config/config.js'
import { historyKey, resetAllHistory, resetHistory } from '../models/history.js'

export class Management extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin管理',
      dsc: '对话重置 / 模型切换 / 帮助',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#chatgpt重置$', fnc: 'reset', permission: 'master' },
        { reg: '^#chatgpt重置全部$', fnc: 'resetAll', permission: 'master' },
        { reg: '^#chatgpt模型\\s*(\\S+)$', fnc: 'setModel', permission: 'master' },
        { reg: '^#chatgpt(帮助|help)$', fnc: 'help', permission: 'master' }
      ]
    })
  }

  async reset (e) {
    resetHistory(historyKey(e))
    await e.reply('已重置当前会话的对话历史')
  }

  async resetAll (e) {
    resetAllHistory()
    await e.reply('已重置所有会话的对话历史')
  }

  async setModel (e) {
    const model = e.msg.match(/^#chatgpt模型\s*(\S+)$/)?.[1]
    if (!model) {
      await e.reply('用法：#chatgpt模型 <模型ID>')
      return
    }
    Config.model = model
    await e.reply(`默认模型已切换为：${model}`)
  }

  async help (e) {
    const cfg = Config.snapshot()
    await e.reply([
      'chatgpt-plugin（Vercel AI SDK 版）指令：',
      `- ${cfg.toggleMode === 'at' ? '@机器人 + 内容' : cfg.togglePrefix + ' + 内容'}：对话`,
      '- #chatgpt重置：清空当前会话历史',
      '- #chatgpt重置全部：清空所有会话历史',
      '- #chatgpt模型 <模型ID>：切换默认模型',
      '- #chatgpt帮助：查看本帮助',
      `当前模型：${cfg.model}`
    ].join('\n'))
  }
}
