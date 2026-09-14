import fs from 'node:fs'
import path from 'node:path'

import { pluginRoot } from '../config/config.js'

let yunzaipu = null

/**
 * HTML 转图片的渲染适配层，按顺序尝试：
 * 1. 直接使用 Yunzai 根目录的 puppeteer 自行渲染（setContent，返回 Buffer）
 * 2. TRSS-Yunzai：global.Renderer.render(name, { tplFile, ... })
 * 3. Miao-Yunzai：global.puppeteer.screenshot(name, { tplFile, ... })
 * 全部不可用时返回 null，由调用方自行回退。
 */

const tmpDir = path.join(pluginRoot, 'data')

function extractBuffer (res) {
  if (!res) return null
  if (Buffer.isBuffer(res)) return res
  if (res instanceof Uint8Array) return Buffer.from(res)
  if (Array.isArray(res)) {
    const first = res.find(Boolean)
    return first ? extractBuffer(first) : null
  }
  if (res?.type === 'image' && res?.file) return extractBuffer(res.file)
  if (res?.data) return extractBuffer(res.data)
  if (res?.img) return extractBuffer(res.img)
  return null
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
  const timeout = new Promise((_, reject) => {
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
      const directBuffer = extractBuffer(image)
      if (directBuffer) return directBuffer
      const extracted = extractBase64(image, true)
      if (extracted) return toBuffer(extracted)
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
      yunzaipu = (await import(pathToFileUrl(file))).default
      return yunzaipu
    } catch (err) {
      global.logger?.debug?.(`[chatgpt-plugin] 加载 Yunzai puppeteer 失败: ${err?.message || err}`)
    }
  }
  return null
}

function pathToFileUrl (file) {
  return new URL(`file://${file.replaceAll('\\', '/')}`).href
}
