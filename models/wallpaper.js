import crypto from 'node:crypto'

import Config from '../config/config.js'

/**
 * 壁纸服务（参考 astrbot_plugin_bizhi 的 wallpaper.py 实现）：
 * 调用腾讯云开发（CloudBase）函数 `app` 的 /wallpaper/wallpaper_days 接口，
 * 请求带 HMAC-SHA256 签名，响应为 OpenSSL 加密的 AES-256-CBC（Salted__ + EVP_BytesToKey 派生 32 字节密钥）。
 */

const CLOUD_CONFIG = {
  endpoint: 'https://env-00jxtf6hq8tr.api-hz.cloudbasefunction.cn',
  functionName: 'app',
  spaceId: 'env-00jxtf6hq8tr',
  spaceAppId: '2021005135628147',
  accessKey: 'eYuqoprO4Ezad1pj',
  secretKey: 'mU0zgq1OsDi6ZoTA'
}

const CLIENT_INFO = {
  platform: 'MP-WEIXIN',
  appId: 'wx633e9b3c05402e0d',
  systemPlatform: 'windows',
  uniPlatform: 'mp-weixin'
}

const RESPONSE_AES_KEY = 'yutuge1079422d21b1941625f8b0628f'

const HTTP_TIMEOUT = 60000

// 最新壁纸列表缓存（接口按天返回，短时间内不会变化）
let latestCache = null
let latestCacheTime = 0
const CACHE_TTL = 10 * 60 * 1000

function sha256Hex (value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmacHex (value, key) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(value, 'utf8').digest('hex')
}

/** OpenSSL EVP_BytesToKey（MD5 迭代派生 key/iv），与 Python 版逐字节一致 */
function evpBytesToKey (password, salt, keyLen, ivLen) {
  const pw = Buffer.from(password, 'utf8')
  let data = Buffer.alloc(0)
  let prev = Buffer.alloc(0)
  while (data.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pw, salt])).digest()
    data = Buffer.concat([data, prev])
  }
  return { key: data.subarray(0, keyLen), iv: data.subarray(keyLen, keyLen + ivLen) }
}

/** 解密 OpenSSL 加密的响应（Salted__ 头 + AES-256-CBC + PKCS7），非加密内容原样返回 */
export function decryptOpensslAes (base64Cipher, password = RESPONSE_AES_KEY) {
  let raw
  try {
    raw = Buffer.from(base64Cipher, 'base64')
  } catch {
    return base64Cipher
  }
  if (raw.length < 16 || !raw.subarray(0, 8).equals(Buffer.from('Salted__'))) {
    return base64Cipher
  }
  const salt = raw.subarray(8, 16)
  const encrypted = raw.subarray(16)
  const { key, iv } = evpBytesToKey(password, salt, 32, 16)
  // 32 字节密钥 → AES-256-CBC（pycryptodome 按密钥长度自动选择，这里显式指定）；Node 自动去除 PKCS7 填充
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function buildInvokeHeaders (bodyJson) {
  const timestamp = String(Date.now())
  const traceId = crypto.randomUUID()
  const headers = {
    'x-to-function-name': CLOUD_CONFIG.functionName,
    'x-from-app-id': CLOUD_CONFIG.spaceAppId,
    'x-from-env-id': CLOUD_CONFIG.spaceId,
    'x-to-env-id': CLOUD_CONFIG.spaceId,
    'x-from-instance-id': timestamp,
    'x-from-function-name': CLOUD_CONFIG.functionName,
    'x-client-timestamp': timestamp,
    'x-alipay-source': 'client',
    'x-request-id': traceId,
    'x-alipay-callid': traceId,
    'x-trace-id': traceId,
    'content-type': 'application/json'
  }
  const signedHeaders = [
    'x-from-app-id',
    'x-from-env-id',
    'x-to-env-id',
    'x-from-instance-id',
    'x-from-function-name',
    'x-client-timestamp',
    'x-to-function-name'
  ]
  const canonicalHeaders = signedHeaders.map(key => `${key}:${headers[key]}\n`).join('')
  const canonicalRequest = [
    'POST',
    '/functions/invokeFunction',
    '',
    canonicalHeaders,
    signedHeaders.join(';'),
    sha256Hex(bodyJson),
    ''
  ].join('\n')
  const authorizationPayload = ['HMAC-SHA256', timestamp, sha256Hex(canonicalRequest), ''].join('\n')
  headers.Authorization = [
    'HMAC-SHA256',
    `Credential=${CLOUD_CONFIG.accessKey},`,
    `SignedHeaders=${signedHeaders.join(';')},`,
    `Signature=${hmacHex(authorizationPayload, CLOUD_CONFIG.secretKey)}`
  ].join(' ')
  return headers
}

async function invokeApp (pathname, param) {
  const body = JSON.stringify({
    path: pathname,
    param,
    client: CLIENT_INFO,
    headers: { token: '' }
  })
  const res = await fetch(`${CLOUD_CONFIG.endpoint}/functions/invokeFunction`, {
    method: 'POST',
    headers: buildInvokeHeaders(body),
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`壁纸接口 HTTP ${res.status}: ${text.slice(0, 120)}`)
  }
  let payload
  try {
    payload = JSON.parse(decryptOpensslAes(text))
  } catch (err) {
    throw new Error(`壁纸接口响应解析失败: ${err?.message || err}`)
  }
  if (payload?.code !== 200) {
    throw new Error(`壁纸接口错误 ${payload?.code}: ${payload?.msg || '未知错误'}`)
  }
  return payload
}

function formatDay (dayMs) {
  const d = new Date(Number(dayMs))
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 获取最新壁纸列表（带缓存），返回 [{ index, code, dayStr, thumbUrl, originalUrl }] */
export async function getLatestWallpapers () {
  const cfg = Config.wallpaper || {}
  if (!cfg.enable) {
    throw new Error('壁纸功能未启用')
  }
  if (latestCache && Date.now() - latestCacheTime < CACHE_TTL) {
    return latestCache
  }
  const payload = await invokeApp('/wallpaper/wallpaper_days', { page: 1, returnAll: true })
  const items = []
  for (const group of payload?.data ?? []) {
    const dayStr = formatDay(group.day)
    for (const wp of group.wallpapers ?? []) {
      items.push({
        index: items.length + 1,
        code: String(wp.code || `item-${items.length + 1}`),
        dayStr,
        thumbUrl: wp.imageUrl || '',
        originalUrl: wp.imageUrlOriginal || wp.imageUrlDetail || wp.imageUrl || ''
      })
    }
  }
  latestCache = items
  latestCacheTime = Date.now()
  return items
}

/** 取某一页壁纸（每页 9 张），返回 { page, totalPages, items } */
export async function getWallpaperPage (page = 1) {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('页码必须是大于等于 1 的整数')
  }
  const pageSize = Config.wallpaper?.pageSize || 9
  const all = await getLatestWallpapers()
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize))
  if (page > totalPages) {
    throw new Error(`页码超出范围，当前最大页数是 ${totalPages}`)
  }
  const items = all.slice((page - 1) * pageSize, page * pageSize)
  return { page, totalPages, items }
}

/** 从页内按编号取原图 URL 列表 */
export function getOriginalUrls (wallpaperPage, indexes) {
  if (!Array.isArray(indexes) || indexes.length === 0) {
    throw new Error('请提供至少一个壁纸编号')
  }
  const itemMap = new Map(wallpaperPage.items.map(item => [item.index, item]))
  const urls = []
  const missing = []
  for (const index of indexes) {
    const item = itemMap.get(index)
    if (item && item.originalUrl) {
      urls.push(item.originalUrl)
    } else {
      missing.push(String(index))
    }
  }
  if (missing.length > 0) {
    throw new Error(`第 ${wallpaperPage.page} 页不存在这些编号: ${missing.join(',')}。请先查看第 ${wallpaperPage.page} 页列表`)
  }
  return urls
}

/** 生成某一页的列表文本 */
export function buildListText (wallpaperPage) {
  const lines = wallpaperPage.items.map(item =>
    `${item.index}. ${item.code}（${item.dayStr}）`
  )
  return `最新壁纸 第 ${wallpaperPage.page}/${wallpaperPage.totalPages} 页：\n${lines.join('\n')}`
}

// 壁纸图床（alioss.ibzhi.com 的 CDN）有 Referer 白名单，
// 空referer/普通站点的 referer 都会被拒（denied by Referer ACL），
// 仅允许微信小程序来源
const WALLPAPER_REFERER = 'https://servicewechat.com/'
const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 下载壁纸图片为 Buffer（自动带过防盗链的 Referer），供 segment.image 发送；网络抖动自动重试一次 */
export async function fetchWallpaperBuffer (url) {
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': IMAGE_UA,
          Referer: WALLPAPER_REFERER,
          Accept: 'image/*,*/*'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(120000)
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length === 0) {
        throw new Error('下载内容为空')
      }
      return buffer
    } catch (err) {
      lastErr = err
      if (attempt < 2) {
        global.logger?.warn?.(`[chatgpt-plugin] 壁纸图片下载失败（${err?.message || err}），1 秒后重试`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
  }
  const cause = lastErr?.cause?.code || lastErr?.cause?.message || ''
  throw new Error(`壁纸图片下载失败: ${lastErr?.message || lastErr}${cause ? ` (${cause})` : ''}`)
}

/** 转义 HTML 属性文本 */
function escapeHtml (text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 生成某一页的预览 HTML（缩略图下载后内嵌为 base64 data URL，
 * 绕开图床 Referer 防盗链——浏览器无 referer 也会被拒）。
 * 注意：不要包含 art-template 的 {{ }} 语法。
 */
export async function buildPreviewHtml (wallpaperPage) {
  const cards = []
  for (const item of wallpaperPage.items) {
    let dataUrl = ''
    try {
      const buffer = await fetchWallpaperBuffer(item.thumbUrl || item.originalUrl)
      const contentType = buffer[0] === 0x89 ? 'image/png' : 'image/jpeg'
      dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`
    } catch (err) {
      global.logger?.warn?.(`[chatgpt-plugin] 壁纸缩略图下载失败（#{${item.index}}）: ${err?.message || err}`)
    }
    const imgTag = dataUrl
      ? `<img src="${dataUrl}" alt="壁纸 ${item.index}"/>`
      : `<div class="placeholder">加载失败</div>`
    cards.push(`
      <div class="card">
        <div class="badge">${item.index}</div>
        ${imgTag}
        <div class="meta">
          <div class="title">${item.index}. ${escapeHtml(item.code)}</div>
          <div class="date">${escapeHtml(item.dayStr)}</div>
        </div>
      </div>`)
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; width: 1170px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    background: linear-gradient(180deg, #f7f2e8 0%, #f3efe7 100%); color: #1f1f23; }
  .wrap { padding: 20px; }
  h1 { font-size: 30px; margin: 0 0 6px; }
  p.sub { margin: 0 0 16px; color: #6b665f; font-size: 16px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .card { background: #fffdf8; border: 1px solid #ddd2c2; border-radius: 16px; padding: 8px; position: relative;
    box-shadow: 0 10px 22px rgba(107, 87, 57, 0.08); }
  .card img { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; border-radius: 12px;
    background: #d8cfbe; display: block; }
  .placeholder { width: 100%; aspect-ratio: 9 / 16; border-radius: 12px; background: #d8cfbe;
    display: flex; align-items: center; justify-content: center; color: #6b665f; font-size: 14px; }
  .badge { position: absolute; top: 14px; left: 14px; background: rgba(17, 18, 20, 0.9); color: #fff;
    border-radius: 999px; padding: 4px 12px; font-weight: 700; font-size: 16px; }
  .meta { padding: 8px 4px 2px; font-size: 15px; }
  .meta .date { color: #6b665f; font-size: 13px; margin-top: 2px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>最新壁纸预览 第 ${wallpaperPage.page} / ${wallpaperPage.totalPages} 页</h1>
  <p class="sub">发送 #下载编号 获取原图，如 #下载1、#下载1,2</p>
  <div class="grid">${cards.join('\n')}</div>
</div>
</body>
</html>`
}
