import fs from 'node:fs'
import path from 'node:path'

import { createRequire } from 'node:module'

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

/** 懒加载的共享 puppeteer 浏览器实例 */
let sharedBrowser = null

function extractBase64 (res, trustString = false) {
  if (!res) return null
  if (Buffer.isBuffer(res)) return res.toString('base64')
  if (res instanceof Uint8Array) return Buffer.from(res).toString('base64')
  if (typeof res === 'string') return (trustString || res.length > 32) ? res : null
  if (Array.isArray(res?.img)) {
    const first = res.img.find(Boolean)
    if (first) return extractBase64(first, true)
  }
  if (typeof res?.img === 'string') return res.img
  if (typeof res?.base64 === 'string') return res.base64
  return null
}

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

function toBuffer (base64) {
  return Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
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
      const image = await withTimeout(renderer.screenshot(name, { ...renderOpts, _plugin: 'chatgpt-plugin' }), RENDER_TIMEOUT, 'Yunzai puppeteer 渲染')
      const directBuffer = extractBuffer(image)
      if (directBuffer) return directBuffer
      const extracted = extractBase64(image, true)
      if (extracted) return toBuffer(extracted)
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] Yunzai puppeteer 渲染失败: ${err?.message || err}`)
  }

  // 2) 直接 Puppeteer 作为最后后备
  try {
    const buffer = await withTimeout(renderWithOwnPuppeteer(renderOpts.tplFile), RENDER_TIMEOUT, '直接 puppeteer 渲染')
    if (buffer) return buffer
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] 直接调用 puppeteer 渲染失败: ${err?.message || err}`)
  }

  // 3) TRSS Renderer / Miao fallback
  try {
    if (global.Renderer?.render) {
      const res = await withTimeout(global.Renderer.render(name, renderOpts), RENDER_TIMEOUT, 'Renderer 渲染')
      const base64 = extractBase64(res, true)
      if (base64) return toBuffer(base64)
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] Renderer 渲染失败: ${err?.message || err}`)
  }

  // 4) Miao-Yunzai 内置 puppeteer 渲染器
  try {
    if (global.puppeteer?.screenshot) {
      const res = await withTimeout(global.puppeteer.screenshot(name, renderOpts), RENDER_TIMEOUT, 'puppeteer 渲染')
      const base64 = extractBase64(res)
      if (base64) {
        global.logger?.debug?.('[chatgpt-plugin] puppeteer 渲染完成')
        return toBuffer(base64)
      }
      global.logger?.warn?.('[chatgpt-plugin] puppeteer 渲染返回为空，尝试下一个渲染器')
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] puppeteer 渲染失败: ${err?.message || err}`)
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

/** 从 Yunzai 根目录（或插件自身）解析 puppeteer 包 */
function loadPuppeteer () {
  try {
    const cwdRequire = createRequire(path.join(process.cwd(), 'package.json'))
    return cwdRequire('puppeteer')
  } catch {}
  try {
    const localRequire = createRequire(path.join(pluginRoot, 'package.json'))
    return localRequire('puppeteer')
  } catch {}
  return null
}

async function renderWithOwnPuppeteer (tplFile) {
  const puppeteer = loadPuppeteer()
  if (!puppeteer) {
    global.logger?.warn?.('[chatgpt-plugin] Yunzai 目录下未找到 puppeteer 包')
    return null
  }
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      // puppeteer v22+ 中 true 即新版 headless；字符串 'new' 已废弃，未来版本会移除
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
  }
  const page = await sharedBrowser.newPage()
  try {
    await page.setViewport({ width: 1210, height: 800 })
    const html = fs.readFileSync(tplFile, 'utf-8')
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await new Promise(resolve => setTimeout(resolve, 4000))
    const body = (await page.$('#container')) || (await page.$('body'))
    if (!body) return null
    return await body.screenshot({ type: 'png', fullPage: true })
  } catch (err) {
    // 浏览器实例可能已崩溃（如目标进程关闭），重置后下次调用会重新拉起
    try { await sharedBrowser?.close() } catch {}
    sharedBrowser = null
    throw err
  } finally {
    await page.close().catch(() => {})
  }
}
