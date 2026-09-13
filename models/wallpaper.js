import crypto from 'node:crypto'

import Config from '../config/config.js'

/**
 * 壁纸服务（参考 astrbot_plugin_bizhi 的 wallpaper.py 实现）：
 * 调用腾讯云开发（CloudBase）函数 `app` 的 /wallpaper/wallpaper_days 接口，
 * 请求带 HMAC-SHA256 签名，响应为 OpenSSL 加密的 AES-128-CBC（Salted__ + EVP_BytesToKey）。
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

/** 解密 OpenSSL 加密的响应（Salted__ 头 + AES-128-CBC + PKCS7），非加密内容原样返回 */
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

/** 下载壁纸图片为 Buffer（自动带过防盗链的 Referer），供 segment.image 发送 */
export async function fetchWallpaperBuffer (url) {
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
    throw new Error(`壁纸图片下载失败：HTTP ${res.status}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length === 0) {
    throw new Error('壁纸图片下载为空')
  }
  return buffer
}
