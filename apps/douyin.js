import { parseShare } from '../models/douyin.js'

function imageSegment (url) {
  if (global.segment?.image) return global.segment.image(url)
  return { type: 'image', file: url }
}

async function makeForward (e, nodes) {
  const common = e.runtime?.common || global.common
  if (common?.makeForwardMsg) return common.makeForwardMsg(e, nodes, '抖音图文')
  if (e.group?.makeForwardMsg) return e.group.makeForwardMsg(nodes)
  if (e.friend?.makeForwardMsg) return e.friend.makeForwardMsg(nodes)
  if (global.Bot?.makeForwardMsg) return global.Bot.makeForwardMsg(nodes)
  throw new Error('当前适配器不支持合并转发')
}

export class Douyin extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin抖音解析',
      dsc: '抖音分享链接无水印解析',
      event: 'message',
      priority: 500,
      rule: [{ reg: 'https?:\\/\\/(?:v\\.douyin\\.com|www\\.douyin\\.com|www\\.iesdouyin\\.com)\\/[^\\s]+', fnc: 'parse' }]
    })
  }

  async parse (e) {
    try {
      const result = await parseShare(e.msg)
      if (result.type === 'video' && result.videoUrl) {
        if (!global.segment?.video) throw new Error('当前适配器不支持视频消息')
        await e.reply(global.segment.video(result.videoUrl))
        return true
      }
      if (result.type === 'note' && result.imageUrls.length) {
        const forward = await makeForward(e, result.imageUrls.map(url => imageSegment(url)))
        await e.reply(forward)
        return true
      }
      throw new Error('未找到可发送的视频或图片')
    } catch (err) {
      global.logger?.error?.(`[chatgpt-plugin] 抖音解析失败: ${err?.message || err}`)
      await e.reply(`抖音解析失败：${err?.message || err}`)
      return true
    }
  }
}
