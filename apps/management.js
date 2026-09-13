import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import Config, { pluginRoot } from '../config/config.js'
import { historyKey, resetAllHistory, resetHistory } from '../models/history.js'

const execAsync = promisify(exec)

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
        { reg: '^#chatgpt更新$', fnc: 'update', permission: 'master' },
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

  async update (e) {
    await e.reply('正在检查更新，请稍候……')
    try {
      const execOpts = { cwd: pluginRoot, windowsHide: true, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
      // 记录更新前的 HEAD，用于判断是否真的有新版本、哪些文件变了
      const { stdout: oldHead } = await execAsync('git rev-parse HEAD', execOpts)
      const { stdout: pullOut, stderr: pullErr } = await execAsync('git pull --ff-only', execOpts)
      const pullOutput = (pullOut || pullErr || '').trim()
      logger.info(`[chatgpt-plugin] #chatgpt更新 输出：${pullOutput}`)
      const { stdout: newHead } = await execAsync('git rev-parse HEAD', execOpts)
      if (oldHead.trim() === newHead.trim()) {
        await e.reply('当前已是最新版本，无需更新~')
        return
      }
      logger.info(`[chatgpt-plugin] 更新：${oldHead.trim().slice(0, 7)} -> ${newHead.trim().slice(0, 7)}`)

      // 检查依赖相关文件是否变更，变了就自动安装依赖
      let depsMsg = ''
      const { stdout: diffOut } = await execAsync(
        `git diff --name-only ${oldHead.trim()} ${newHead.trim()}`, execOpts
      )
      const changedFiles = diffOut.split(/\r?\n/).filter(Boolean)
      const DEP_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json']
      if (changedFiles.some(file => DEP_FILES.includes(file))) {
        await e.reply('检测到依赖变更，正在安装依赖，可能需要几分钟……')
        const usePnpm = fs.existsSync(path.join(pluginRoot, 'pnpm-lock.yaml'))
        const cmd = usePnpm
          ? 'pnpm install --no-frozen-lockfile'
          : 'npm install --no-audit --no-fund'
        logger.info(`[chatgpt-plugin] 更新依赖：${cmd}`)
        const { stdout: installOut, stderr: installErr } = await execAsync(cmd, {
          ...execOpts,
          timeout: 600000
        })
        const installTail = (installOut || installErr || '').trim().split(/\r?\n/).slice(-3).join(' | ')
        logger.info(`[chatgpt-plugin] 依赖安装完成：${installTail}`)
        depsMsg = usePnpm ? '（依赖已通过 pnpm 安装）' : '（依赖已通过 npm 安装）'
      }

      await e.reply([
        '更新完成，正在自动重启……',
        ...(pullOutput ? [pullOutput.split(/\r?\n/).slice(-8).join('\n')] : []),
        depsMsg
      ].filter(Boolean).join('\n'))
      this.scheduleRestart()
    } catch (err) {
      logger.error(`[chatgpt-plugin] 更新失败：${err?.message || err}`)
      await e.reply(`更新失败：${(err?.stderr || err?.message || err).toString().trim().slice(0, 300)}`)
    }
  }

  /** 延迟自动重启：优先 Yunzai 内置重启（会回报重启成功），否则退出进程交给守护进程拉起 */
  scheduleRestart () {
    setTimeout(() => {
      try {
        if (typeof Bot.restart === 'function') {
          const ret = Bot.restart()
          if (ret?.catch) {
            ret.catch(err => {
              logger.error(`[chatgpt-plugin] Bot.restart 失败，改为直接退出进程：${err?.message || err}`)
              process.exit(0)
            })
          }
        } else {
          process.exit(0)
        }
      } catch (err) {
        logger.error(`[chatgpt-plugin] 重启失败：${err?.message || err}，请手动重启`)
        process.exit(0)
      }
    }, 2000)
  }

  async help (e) {
    const cfg = Config.snapshot()
    const triggerDesc = cfg.toggleMode === 'at'
      ? (e.isGroup ? '@机器人 + 内容（或 #chat + 内容）' : '直接发送内容')
      : `${cfg.togglePrefix} + 内容`
    await e.reply([
      'chatgpt-plugin（Vercel AI SDK 版）指令：',
      `- ${triggerDesc}：对话`,
      '- #chatgpt重置：清空当前会话历史',
      '- #chatgpt重置全部：清空所有会话历史',
      '- #chatgpt模型 <模型ID>：切换默认模型',
      '- #chatgpt更新：拉取最新代码、按需安装依赖并自动重启',
      '- #画图 <描述>：生成图片',
      '- #改图 <指令>（附带/引用图片）：编辑图片',
      '- #chatgpt帮助：查看本帮助',
      `当前模型：${cfg.model}`,
      `图片模型：${cfg.image?.model || '未配置（图片功能不可用）'}${cfg.image?.model && cfg.image?.asTool !== false ? '（对话中可调用）' : ''}`,
      `apiKey：${cfg.apiKey ? '已配置' : '未配置（对话不可用）'}`,
      `触发模式：${cfg.toggleMode === 'at' ? '@触发（私聊免@）' : '前缀触发'}，前缀：${cfg.togglePrefix}`
    ].join('\n'))
  }
}
