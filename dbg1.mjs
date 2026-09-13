import http from 'node:http'
const server = http.createServer((req, res) => {
  if (req.url === '/ref.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('aGk=', 'base64')) }
  else { res.writeHead(404); res.end() }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const url = `http://127.0.0.1:${port}/ref.png`
try {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
  console.log('direct fetch ok:', res.status, res.headers.get('content-type'))
} catch (err) {
  console.log('direct fetch FAILED:', err?.message, '| cause:', err?.cause?.message)
}
// 再测插件里的 resolveImages 全链路
const { generateImageBase64 } = await import('./models/image.js')
const Config = (await import('./config/config.js')).default
Config.image = { ...Config.image, model: 'm', baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'k' }
// 给个假的 v1 端点让 edits 返回标准 JSON，观察送进 API 的图片形态
const routes = [url]
