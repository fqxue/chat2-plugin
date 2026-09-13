import Config from '../config/config.js'
import { renderHtmlToImage } from '../models/render.js'
import { toImageSegment } from '../models/image.js'
import { buildListText, buildPreviewHtml, fetchWallpaperBuffer, getWallpaperOriginalUrls, getWallpaperPage } from '../models/wallpaper.js'

/** 下载并发送壁纸图片（图床有 Referer 防盗链，必须由插件下载后发 Buffer） */
async function sendImage (e, url) {
  const buffer = await fetchWallpaperBuffer(url)
  await e.reply(await toImageSegment(buffer))
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
        { reg: '^#下载\\s*([0-9]+(?:[,，][0-9]+)*)$', fnc: 'download' }
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
      // 只发送一张渲染好的预览大图（页码/编号/日期/下载提示都在图里）
      const preview = await buildPreviewHtml(wallpaperPage)
        .then(html => renderHtmlToImage(html, `chatgpt-wallpaper-page-${wallpaperPage.page}`))
      if (preview) {
        await e.reply(await toImageSegment(preview, 'chatgpt-wallpaper.jpg'))
        return true
      }
      // 无可用渲染器时回退为纯文字列表
      logger.warn('[chatgpt-plugin] 无可用渲染器，壁纸预览回退为文字列表')
      await e.reply(buildListText(wallpaperPage) +
        `\n发送 #下载1 可下载原图（当前页）`)
    } catch (err) {
      logger.error(`[chatgpt-plugin] 壁纸列表获取失败: ${err?.message || err}`)
      await e.reply(`壁纸获取失败：${err?.message || err}`)
    }
    return true
  }

  /** #下载1 或 #下载1,2：把当前页指定编号的壁纸原图发给用户 */
  async download (e) {
    if (!Config.wallpaper?.enable) {
      await e.reply('壁纸功能未启用')
      return true
    }
    const indexes = e.msg.match(/^#下载\s*([0-9]+(?:[,，][0-9]+)*)$/)?.[1]
      ?.split(/[,，]+/)
      .map(Number)
      .filter(n => Number.isInteger(n) && n > 0) ?? []
    if (indexes.length === 0) {
      await e.reply('用法：#下载1 或 #下载1,2（编号见 #壁纸 列表）')
      return true
    }
    try {
      const urls = await getWallpaperOriginalUrls(indexes)
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
