import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { pluginRoot } from '../config/config.js'

let yunzaipu = null

/**
 * HTML 转图片的渲染适配层，按顺序尝试：
 * 使用 Yunzai 根目录的 puppeteer 截图器，统一转换为 Buffer。
 * 不可用时返回 null，由调用方报告渲染失败。
 */

const tmpDir = path.join(pluginRoot, 'data')

function extractBuffer (res) {
  if (!res) return null
  if (Buffer.isBuffer(res)) return res
  if (res instanceof Uint8Array) return Buffer.from(res)
  if (typeof res === 'string') {
    const base64 = res.match(/^base64:\/\/(.+)$/s)?.[1] ??
      res.match(/^data:[^;,]+;base64,(.+)$/s)?.[1]
    return base64 ? Buffer.from(base64, 'base64') : null
  }
  if (Array.isArray(res)) {
    const first = res.find(Boolean)
    return first ? extractBuffer(first) : null
  }
  if (res?.type === 'image' && res?.file) return extractBuffer(res.file)
  if (res?.data) return extractBuffer(res.data)
  if (res?.img) return extractBuffer(res.img)
  return null
}

function extractFileReference (res) {
  if (!res) return null
  if (typeof res === 'string') return res
  if (res instanceof URL) return res.href
  if (Array.isArray(res)) {
    for (const item of res) {
      const reference = extractFileReference(item)
      if (reference) return reference
    }
    return null
  }
  return extractFileReference(res?.file ?? res?.data ?? res?.img)
}

async function readRenderResult (res) {
  const directBuffer = extractBuffer(res)
  if (directBuffer) return directBuffer

  const reference = extractFileReference(res)
  if (!reference || /^(?:base64|data):/i.test(reference)) return null
  if (/^https?:/i.test(reference)) {
    const response = await fetch(reference, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`读取渲染图片失败：HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    return buffer.length > 0 ? buffer : null
  }

  const filePath = reference.startsWith('file:')
    ? new URL(reference)
    : path.resolve(reference)
  const buffer = fs.readFileSync(filePath)
  return buffer.length > 0 ? buffer : null
}

/**
 * 渲染 HTML 为图片
 * @param {string} html 完整 HTML 文本（注意不要包含 art-template 的 {{ }} 语法）
 * @param {string} name 渲染任务名（用作模板文件名）
 * @returns {Promise<Buffer|null>} 图片 Buffer，无可用渲染器时返回 null
 */
export async function renderHtmlToImage (html, name = 'chatgpt-plugin-render') {
  fs.mkdirSync(tmpDir, { recursive: true })
  // 唯一文件名：TRSS 的 Renderer.readTpl 按路径缓存模板内容，
  // 固定文件名会拿到上一次的陈旧缓存（壁纸列表每天更新）
  const tplFile = path.join(tmpDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`)
  fs.writeFileSync(tplFile, html, 'utf-8')
  const renderOpts = { tplFile, imgType: 'jpeg', quality: 90, saveId: name }

  try {
    return await tryRenderers(renderOpts, name)
  } finally {
    // 同步清理临时模板，避免 data 目录无限膨胀
    try {
      fs.rmSync(tplFile, { force: true })
    } catch {}
  }
}

// 单个渲染器的超时预算：渲染器卡死（如 VPS 上 Chromium 启动假死）
// 不能让它把整个指令永远挂住——超时后落到下一个渲染器/文字回退
const RENDER_TIMEOUT = 60000
const WALLPAPER_RENDER_TIMEOUT = 30000

function withTimeout (promise, ms, label) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms / 1000} 秒）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function tryRenderers (renderOpts, name) {
  // 1) Yunzai/TRSS 兼容截图器：返回 segment.image(buffer)，可直接交给 e.reply
  try {
    const renderer = await loadYunzaiPuppeteer()
    if (renderer?.screenshot) {
      const timeout = name.startsWith('chatgpt-wallpaper-') ? WALLPAPER_RENDER_TIMEOUT : RENDER_TIMEOUT
      const image = await withTimeout(renderer.screenshot(name, { ...renderOpts, _plugin: 'chatgpt-plugin' }), timeout, 'Yunzai puppeteer 渲染')
      const directBuffer = await readRenderResult(image)
      if (directBuffer) return directBuffer
      global.logger?.warn?.('[chatgpt-plugin] Yunzai puppeteer 返回了无法识别的图片数据')
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] Yunzai puppeteer 渲染失败: ${err?.message || err}`)
  }

  return null
}

async function loadYunzaiPuppeteer () {
  if (yunzaipu) return yunzaipu
  const candidates = [
    path.join(process.cwd(), 'lib/puppeteer/puppeteer.js'),
    path.join(process.cwd(), 'lib/puppeteer/puppeteer.mjs')
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      yunzaipu = (await import(pathToFileURL(file).href)).default
      return yunzaipu
    } catch (err) {
      global.logger?.debug?.(`[chatgpt-plugin] 加载 Yunzai puppeteer 失败: ${err?.message || err}`)
    }
  }
  return null
}
