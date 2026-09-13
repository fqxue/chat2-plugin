import fs from 'node:fs'
import ChatGPTConfig from './config/config.js'

logger.info('**************************************')
logger.info('chatgpt-plugin（Vercel AI SDK 版）加载中')

if (!global.segment) {
  // 仅独立调试环境需要；Yunzai/Miao/TRSS 都自带 segment。
  // 都不存在时不能让 import 异常炸掉插件加载
  try {
    global.segment = (await import('icqq')).segment
  } catch {
    try {
      global.segment = (await import('oicq')).segment
    } catch (err) {
      logger.warn(`icqq/oicq 均不可用，segment 由适配器提供: ${err?.message || err}`)
    }
  }
}

const appsDir = new URL('./apps/', import.meta.url)
const files = fs.readdirSync(appsDir).filter(file => file.endsWith('.js'))

let ret = []
files.forEach(file => {
  ret.push(import(new URL(`./apps/${file}`, import.meta.url).href))
})

ret = await Promise.allSettled(ret)

const apps = {}
for (const i in files) {
  const name = files[i].replace('.js', '')
  if (ret[i].status !== 'fulfilled') {
    logger.error(`载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

global.chatgpt = {}

if (!ChatGPTConfig.apiKey) {
  logger.warn('chatgpt-plugin 尚未配置 apiKey，对话功能不可用。请编辑 config/config.yaml 或使用锅巴配置')
}

logger.info('chatgpt-plugin加载成功')
logger.info(`当前版本${ChatGPTConfig.version}`)
logger.info('**************************************')

export { apps }
