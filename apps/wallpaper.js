import Config from '../config/config.js'
import { historyKey } from '../models/history.js'
import { buildListText, fetchWallpaperBuffer, getOriginalUrls, getWallpaperPage } from '../models/wallpaper.js'

// 每个会话最近浏览的壁纸页，#壁纸下载 时默认使用
const lastViewedPage = new Map()

/** 下载并发送壁纸图片（图床有 Referer 防盗链，必须由插件下载后发 Buffer） */
async function sendImage (e, url) {
  const buffer = await fetchWallpaperBuffer(url)
  if (global.segment?.image) {
    await e.reply(segment.image(buffer))
  } else {
    await e.reply(buffer)
  }
}

export class Wallpaper extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin壁纸',
      dsc: '最新壁纸列表与下载原图',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#壁纸(\\s*\\d+)?$', fnc: 'list' },
        { reg: '^#(壁纸下载|下载壁纸)\\s*([0-9,，\\s]+)$', fnc: 'download' }
      ]
    })
  }

  /** #壁纸 [页码]：查看某页最新壁纸列表 */
  async list (e) {
    if (!Config.wallpaper?.enable) {
      await e.reply('壁纸功能未启用')
      return true
    }
    const page = Number(e.msg.match(/^#壁纸(?:\s*(\d+))?$/)?.[1] || 1)
    try {
      const wallpaperPage = await getWallpaperPage(page)
      lastViewedPage.set(historyKey(e), wallpaperPage.page)
      await e.reply(buildListText(wallpaperPage) +
        `\n发送 #壁纸下载 1,2 可下载原图（当前页）`)
      // 随列表发送少量缩略图预览
      const previewCount = Math.min(Config.wallpaper?.previewCount ?? 3, wallpaperPage.items.length)
      for (const item of wallpaperPage.items.slice(0, Math.max(0, previewCount))) {
        if (item.thumbUrl) {
          await sendImage(e, item.thumbUrl)
        }
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 壁纸列表获取失败: ${err?.message || err}`)
      await e.reply(`壁纸获取失败：${err?.message || err}`)
    }
    return true
  }

  /** #壁纸下载 1,2：把当前页指定编号的原图发给用户 */
  async download (e) {
    if (!Config.wallpaper?.enable) {
      await e.reply('壁纸功能未启用')
      return true
    }
    const indexes = e.msg.match(/^#(?:壁纸下载|下载壁纸)\s*([0-9,，\s]+)$/)?.[1]
      ?.split(/[,，\s]+/)
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0) ?? []
    if (indexes.length === 0) {
      await e.reply('用法：#壁纸下载 1,2（编号见 #壁纸 列表）')
      return true
    }
    const page = lastViewedPage.get(historyKey(e)) || 1
    try {
      const wallpaperPage = await getWallpaperPage(page)
      const urls = getOriginalUrls(wallpaperPage, indexes)
      for (const url of urls) {
        await sendImage(e, url)
      }
    } catch (err) {
      logger.error(`[chatgpt-plugin] 壁纸下载失败: ${err?.message || err}`)
      await e.reply(`壁纸下载失败：${err?.message || err}`)
    }
    return true
  }
}
