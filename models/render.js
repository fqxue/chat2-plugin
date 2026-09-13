import fs from 'node:fs'
import path from 'node:path'

import { createRequire } from 'node:module'

import { pluginRoot } from '../config/config.js'

/**
 * HTML 转图片的渲染适配层，按顺序尝试：
 * 1. TRSS-Yunzai：global.Renderer.render(name, { tplFile, ... })，返回 Buffer
 * 2. Miao-Yunzai：global.puppeteer.screenshot(name, { tplFile, ... })，返回 { img: [base64] }
 * 3. 直接使用 Yunzai 根目录的 puppeteer 自行渲染（setContent，无模板处理）
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
  const tplFile = path.join(tmpDir, `${name}.html`)
  fs.writeFileSync(tplFile, html, 'utf-8')
  const renderOpts = { tplFile, imgType: 'jpeg', quality: 90, saveId: name }

  // 1) TRSS-Yunzai 渲染器（内置 puppeteer / shotium 后端，返回 Buffer）
  try {
    if (global.Renderer?.render) {
      const res = await global.Renderer.render(name, renderOpts)
      const base64 = extractBase64(res)
      if (base64) {
        global.logger?.debug?.('[chatgpt-plugin] Renderer 渲染完成')
        return toBuffer(base64)
      }
      global.logger?.warn?.('[chatgpt-plugin] Renderer 渲染返回为空，尝试下一个渲染器')
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] Renderer 渲染失败: ${err?.message || err}`)
  }

  // 2) Miao-Yunzai 内置 puppeteer 渲染器
  try {
    if (global.puppeteer?.screenshot) {
      const res = await global.puppeteer.screenshot(name, renderOpts)
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

  // 3) 直接使用 Yunzai 根目录的 puppeteer 渲染（TRSS 内置渲染器本身依赖它，包一定在）
  try {
    const buffer = await renderWithOwnPuppeteer(html)
    if (buffer) {
      global.logger?.info?.('[chatgpt-plugin] 使用 Yunzai 根目录 puppeteer 渲染完成')
      return buffer
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] 直接调用 puppeteer 渲染失败: ${err?.message || err}`)
  }

  return null
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

async function renderWithOwnPuppeteer (html) {
  const puppeteer = loadPuppeteer()
  if (!puppeteer) {
    global.logger?.warn?.('[chatgpt-plugin] Yunzai 目录下未找到 puppeteer 包')
    return null
  }
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--disable-gpu', '--disable-setuid-sandbox', '--no-sandbox', '--no-zygote']
    })
  }
  const page = await sharedBrowser.newPage()
  try {
    await page.setViewport({ width: 1210, height: 800 })
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 })
    const body = (await page.$('#container')) || (await page.$('body'))
    if (!body) return null
    return await body.screenshot({ type: 'jpeg', quality: 90 })
  } finally {
    await page.close().catch(() => {})
  }
}
