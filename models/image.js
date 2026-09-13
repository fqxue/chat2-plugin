import { generateImage } from 'ai'
import Config from '../config/config.js'
import { getImageModel } from './provider.js'

/**
 * 图片生成/编辑的共享核心：
 * - 直接指令调用（apps/image.js）
 * - 作为 agent 工具供对话模型调用（apps/chat.js）
 * 复用同一个函数，保证两种入口行为一致。
 */

const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 从事件中收集真实存在的图片引用（当前消息附带 or 引用消息中的图片） */
export function collectEventImages (e) {
  const urls = []
  if (Array.isArray(e?.img)) {
    urls.push(...e.img)
  }
  if (e?.source) {
    const segments = e.source.message || e.source.msg || []
    for (const seg of segments) {
      const url = seg?.url || seg?.file
      if ((seg?.type === 'image' || seg?.type === 'flashimage') && typeof url === 'string') {
        urls.push(url)
      }
    }
  }
  return urls.filter(url => /^(https?|file|data):/i.test(url))
}

/** 预下载参考图为 data URL；失败返回 null（回退为直接传 URL） */
async function fetchImageDataUrl (url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': IMAGE_UA, Accept: 'image/*,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0]
    if (!contentType.startsWith('image/')) {
      throw new Error(`响应不是图片：${contentType}`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    return `data:${contentType};base64,${buffer.toString('base64')}`
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] 预下载参考图失败，回退为直接传 URL：${err?.message || err}`)
    return null
  }
}

/** 将调用方传入的图片引用归一化为 ai 可接受的 DataContent */
async function resolveImages (images = []) {
  const resolved = []
  for (const img of images) {
    const s = String(img)
    if (/^data:/i.test(s)) {
      resolved.push(s)
    } else if (/^https?:/i.test(s)) {
      // 平台图片 URL（QQ/Telegram 等）常带防盗链或 UA 校验，
      // 先由插件侧预下载，SDK 的默认下载器大多会 403
      resolved.push(await fetchImageDataUrl(s) ?? s)
    } else if (/^file:/i.test(s)) {
      resolved.push(s)
    } else {
      // 裸 base64 包装为 data URL
      resolved.push(`data:image/png;base64,${s}`)
    }
  }
  return resolved
}

/** 从模型返回的 Markdown 文本中提取图片 URL（兼容非标准返回格式的图片站点） */
export function extractImageUrlFromMarkdown (text) {
  if (!text || typeof text !== 'string') return null
  // ![alt](url) 优先
  const md = text.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
  if (md) return md[1]
  // [文字](url) 次之（如「点击下载」）
  const link = text.match(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/)
  if (link) return link[1]
  // 裸图片 URL 兜底
  const bare = text.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif)/i)
  return bare ? bare[0] : null
}

/** 带浏览器 UA 下载图片，返回 base64 */
async function downloadImageBase64 (url) {
  global.logger?.info?.(`[chatgpt-plugin] 开始下载生成结果：${url}`)
  const res = await fetch(url, {
    headers: { 'User-Agent': IMAGE_UA, Accept: 'image/*,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000)
  })
  if (!res.ok) {
    throw new Error(`下载生成结果失败：HTTP ${res.status}`)
  }
  const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0]
  if (!contentType.startsWith('image/')) {
    throw new Error(`生成结果不是图片（Content-Type: ${contentType}），URL: ${url}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  global.logger?.info?.(`[chatgpt-plugin] 生成结果下载完成：${contentType}，${Math.round(buffer.length / 1024)} KB`)
  return buffer.toString('base64')
}

/**
 * 生成或编辑图片
 * @param {object} opts
 * @param {string} opts.prompt 图片描述 / 编辑指令
 * @param {string[]} [opts.images] 参考图片（URL 或 base64），提供时走编辑流程
 * @returns {Promise<string>} 图片 base64
 */
export async function generateImageBase64 ({ prompt, images = [] }) {
  const cfg = Config.snapshot()
  const imageCfg = cfg.image || {}
  if (!imageCfg.model) {
    throw new Error('未启用图片功能，请联系主人配置 image.model')
  }

  const params = {
    model: getImageModel(),
    // 图片接口（尤其是编辑模型）通常比对话慢得多，使用独立的超时预算
    abortSignal: AbortSignal.timeout(imageCfg.timeout ?? 180000)
  }

  if (images.length > 0) {
    // 编辑模式：图片输入 + 文字指令
    params.prompt = {
      images: await resolveImages(images),
      text: prompt || '请编辑这张图片'
    }
  } else {
    if (!prompt) {
      throw new Error('缺少图片描述（prompt）')
    }
    params.prompt = prompt
  }
  if (imageCfg.size) {
    params.size = imageCfg.size
  }

  try {
    const { image } = await generateImage(params)
    if (!image?.base64) {
      throw new Error('图片模型没有返回图片数据')
    }
    return image.base64
  } catch (err) {
    // 兼容非标准返回：部分图片站点的接口返回 Markdown 文本
    //（如 `![xx](url)` / `[点击下载](url)`）而非 JSON，
    // SDK 解析失败后从响应体中提取图片 URL 并自行下载
    const body = typeof err?.responseBody === 'string'
      ? err.responseBody
      : typeof err?.text === 'string'
        ? err.text
        : ''
    const url = extractImageUrlFromMarkdown(body)
    if (url) {
      global.logger?.info?.(`[chatgpt-plugin] 图片接口返回 Markdown 格式，提取图片 URL 自行下载：${url}`)
      return await downloadImageBase64(url)
    }
    throw err
  }
}
