import Config from '../config/config.js'
import { generateImageBase64 } from '../models/image.js'

/** 从事件中收集图片引用（当前消息附带 or 引用消息中的图片），返回 URL 列表 */
function collectImages (e) {
  const urls = []
  if (Array.isArray(e.img)) {
    urls.push(...e.img)
  }
  if (e.source) {
    const segments = e.source.message || e.source.msg || []
    for (const seg of segments) {
      const type = seg?.type
      const url = seg?.url || seg?.file
      if ((type === 'image' || type === 'flashimage') && typeof url === 'string') {
        urls.push(url)
      }
    }
  }
  return urls.filter(url => /^(https?|file|data):/i.test(url))
}

async function sendImage (e, base64) {
  const buffer = Buffer.from(base64, 'base64')
  if (global.segment?.image) {
    await e.reply(segment.image(buffer))
  } else {
    // 兜底：部分适配器支持直接发 Buffer
    await e.reply(buffer)
  }
}

export class ImageGen extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin画图',
      dsc: '图片生成与编辑（ai generateImage）',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#画图[ 　]*([\\s\\S]+)$', fnc: 'draw' },
        { reg: '^#(改图|编辑图片|P图)[ 　]*([\\s\\S]*)$', fnc: 'edit' }
      ]
    })
  }

  /** #画图 <描述>：文生图 */
  async draw (e) {
    if (!Config.image?.model) {
      await e.reply('图片功能未启用，请联系主人配置 image.model')
      return true
    }
    const prompt = e.msg.match(/^#画图[ 　]*([\s\S]+)$/)?.[1]?.trim()
    if (!prompt) {
      await e.reply('用法：#画图 <图片描述>')
      return true
    }
    logger.info(`[chatgpt-plugin] 图片生成: ${prompt}`)
    await e.reply('正在生成图片，请稍候……')
    try {
      const base64 = await generateImageBase64({ prompt })
      await sendImage(e, base64)
    } catch (err) {
      logger.error(`[chatgpt-plugin] 图片生成失败: ${err?.message || err}`)
      await e.reply(`图片生成失败：${err?.message || err}`)
    }
    return true
  }

  /** #改图 <指令>：基于附带/引用的图片进行编辑 */
  async edit (e) {
    if (!Config.image?.model) {
      await e.reply('图片功能未启用，请联系主人配置 image.model')
      return true
    }
    const images = collectImages(e)
    if (images.length === 0) {
      await e.reply('请附带图片或引用一条含图片的消息，再加编辑指令。例：回复图片消息发送「#改图 把背景换成海边」')
      return true
    }
    const prompt = e.msg.match(/^#(?:改图|编辑图片|P图)[ 　]*([\s\S]*)$/)?.[1]?.trim() || ''
    logger.info(`[chatgpt-plugin] 图片编辑: ${prompt || '(默认指令)'}，参考图片 ${images.length} 张`)
    await e.reply('正在编辑图片，请稍候……')
    try {
      const base64 = await generateImageBase64({ prompt, images })
      await sendImage(e, base64)
    } catch (err) {
      logger.error(`[chatgpt-plugin] 图片编辑失败: ${err?.message || err}`)
      await e.reply(`图片编辑失败：${err?.message || err}`)
    }
    return true
  }
}
