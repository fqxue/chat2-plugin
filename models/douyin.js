const SHARE_URL_RE = /https?:\/\/(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com)\/[^\s\])]+/i
const AWEME_PATH_RE = /\/(?:video|note|share\/video)\/(\d+)(?:[/?#]|$)/i
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'

export class DouyinParseError extends Error {
  constructor (message, code = 'PARSE_ERROR') {
    super(message)
    this.name = 'DouyinParseError'
    this.code = code
  }
}

export function extractShareUrl (text) {
  const match = String(text || '').match(SHARE_URL_RE)
  if (!match) throw new DouyinParseError('消息中未找到抖音分享链接', 'INVALID_INPUT')
  return match[0].replace(/[.,;!?，。；！？]+$/, '')
}

function first (obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key]
}

function urls (value) {
  const list = first(value, 'url_list', 'urlList')
  return Array.isArray(list) ? list.filter(url => typeof url === 'string' && /^https?:/i.test(url)) : []
}

function normalize (detail) {
  const awemeId = String(first(detail, 'aweme_id', 'awemeId') || '')
  if (!awemeId) throw new DouyinParseError('抖音响应缺少作品 ID', 'INVALID_RESPONSE')
  const rawImages = Array.isArray(detail.images) ? detail.images : []
  const images = rawImages.map((image, index) => {
    const list = urls(image)
    return { index: index + 1, width: first(image, 'width'), height: first(image, 'height'), uri: first(image, 'uri'), url: list[0] || null, alternativeUrls: list.slice(1) }
  }).filter(image => image.url)
  let video = null
  if (!images.length && detail.video) {
    const list = urls(first(detail.video, 'play_addr', 'playAddr', 'play_addr_h264', 'playAddrH264'))
    if (list.length) video = { width: first(detail.video, 'width'), height: first(detail.video, 'height'), durationMs: first(detail.video, 'duration'), url: list[0], alternativeUrls: list.slice(1) }
  }
  return { awemeId, type: images.length ? 'note' : 'video', canonicalUrl: `https://www.douyin.com/${images.length ? 'note' : 'video'}/${awemeId}`, description: first(detail, 'desc') || '', awemeType: first(detail, 'aweme_type', 'awemeType') ?? null, videoUrl: video?.url || null, imageUrls: images.map(image => image.url), video, images, music: null }
}

export function parseDetailJson (payload) {
  const value = typeof payload === 'string' ? JSON.parse(payload) : payload
  const detail = value?.aweme_detail || value?.awemeDetail
  if (!detail) throw new DouyinParseError('详情接口未返回 aweme_detail', 'INVALID_RESPONSE')
  return normalize(detail)
}

export function extractAwemeId (url) {
  const id = String(url || '').match(AWEME_PATH_RE)?.[1]
  if (!id) throw new DouyinParseError('无法从抖音链接提取作品 ID', 'INVALID_URL')
  return id
}

export async function parseShare (input, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch')
  const shareUrl = extractShareUrl(input)
  const cookie = String(options.cookie ?? '').replace(/^\s*cookie\s*:\s*/i, '').trim()
  global.logger?.info?.(`[chatgpt-plugin] 抖音解析请求：cookie=${cookie ? `已配置(${cookie.length}字符)` : '未配置'}`)
  const response = await fetchImpl(shareUrl, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } })
  global.logger?.info?.(`[chatgpt-plugin] 抖音响应：HTTP ${response.status}，最终地址 ${response.url || shareUrl}`)
  if (!response.ok) throw new DouyinParseError(`抖音页面 HTTP ${response.status}`, 'HTTP_ERROR')
  const redirectUrl = response.url || shareUrl
  const awemeId = extractAwemeId(redirectUrl)
  const detailUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${encodeURIComponent(awemeId)}&device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&version_code=190500&version_name=19.5.0`
  global.logger?.info?.(`[chatgpt-plugin] 请求抖音详情接口：${detailUrl}`)
  const detailResponse = await fetchImpl(detailUrl, {
    headers: {
      'user-agent': UA,
      accept: 'application/json,text/plain,*/*',
      referer: redirectUrl,
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    }
  })
  const detailText = await detailResponse.text()
  global.logger?.info?.(`[chatgpt-plugin] 抖音详情接口响应：HTTP ${detailResponse.status}，长度 ${detailText.length}`)
  if (!detailResponse.ok || !detailText.trim()) {
    throw new DouyinParseError('抖音详情接口未返回数据，请更新 Cookie 或稍后重试', 'DETAIL_EMPTY')
  }
  return { ...parseDetailJson(detailText), shareUrl, redirectUrl }
}
