import fs from 'node:fs'
import path from 'node:path'

import { pluginRoot } from '../config/config.js'

/**
 * HTML 转图片的渲染适配层，按顺序尝试 Yunzai 生态的渲染器：
 * 1. TRSS-Yunzai：global.Renderer.render(name, { tplFile, ... })
 * 2. Miao-Yunzai：global.puppeteer.screenshot(name, { tplFile, ... })
 * 两者都不可用时返回 null，由调用方自行回退（如分图发送）。
 */

const tmpDir = path.join(pluginRoot, 'data')

function extractBase64 (res) {
  if (!res) return null
  if (typeof res === 'string' && res.length > 64) return res
  if (Array.isArray(res?.img) && typeof res.img[0] === 'string') return res.img[0]
  if (typeof res?.img === 'string') return res.img
  if (typeof res?.base64 === 'string') return res.base64
  if (typeof res?.buffer !== 'undefined') return Buffer.from(res.buffer).toString('base64')
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
  const tplFile = path.join(tmpDir, `${name}.html`)
  fs.writeFileSync(tplFile, html, 'utf-8')
  const renderOpts = { tplFile, imgType: 'jpeg', quality: 90, saveId: name }

  // 1) TRSS-Yunzai 渲染器（含 TRSS-Plugin 的 puppeteer 后端）
  try {
    if (global.Renderer?.render) {
      const res = await global.Renderer.render(name, renderOpts)
      const base64 = extractBase64(res)
      if (base64) {
        global.logger?.debug?.('[chatgpt-plugin] 使用 Renderer 渲染完成')
        return Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
      }
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
        global.logger?.debug?.('[chatgpt-plugin] 使用 puppeteer 渲染完成')
        return Buffer.from(base64.replace(/^data:[^,]+,/, ''), 'base64')
      }
    }
  } catch (err) {
    global.logger?.warn?.(`[chatgpt-plugin] puppeteer 渲染失败: ${err?.message || err}`)
  }

  return null
}
