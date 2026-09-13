import fs from 'node:fs'
import ChatGPTConfig from './config/config.js'

logger.info('**************************************')
logger.info('chatgpt-plugin（Vercel AI SDK 版）加载中')

if (!global.segment) {
  try {
    global.segment = (await import('icqq')).segment
  } catch (err) {
    global.segment = (await import('oicq')).segment
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

logger.info('chatgpt-plugin加载成功')
logger.info(`当前版本${ChatGPTConfig.version}`)
logger.info('**************************************')

export { apps }
