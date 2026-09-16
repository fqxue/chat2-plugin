import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import Config from '../config/config.js'

/**
 * 基于 Vercel AI SDK 的模型提供方。
 * 使用 @ai-sdk/openai-compatible 适配任意 OpenAI 兼容接口，
 * 返回的模型可直接传给 ai 包的 generateText / generateImage 等函数。
 */

const providers = new Map()

function getProvider (baseURL, apiKey, name) {
  if (!baseURL || !apiKey) {
    throw new Error('尚未配置 apiKey 或 baseURL，请编辑 plugins/chatgpt-plugin/config/config.yaml 或使用锅巴配置')
  }
  const key = `${name}|${baseURL}|${apiKey}`
  let provider = providers.get(key)
  if (!provider) {
    provider = createOpenAICompatible({ name, baseURL, apiKey })
    providers.set(key, provider)
  }
  return provider
}

/**
 * 获取一个 LanguageModel 实例（对话用）
 * @param {string} [modelId] 模型 ID，默认取配置中的 model
 */
export function getModel (modelId) {
  const cfg = Config.snapshot()
  const provider = getProvider(cfg.baseURL, cfg.apiKey, 'chatgpt-plugin')
  const id = modelId || cfg.model
  return provider.chatModel(id)
}

/**
 * 获取一个 ImageModel 实例（图片生成/编辑用）
 * 使用配置中的 image.model；apiKey / baseURL 留空时复用主配置
 */
export function getImageModel () {
  const cfg = Config.snapshot()
  const image = cfg.image || {}
  if (!image.model) {
    throw new Error('尚未配置图片模型（image.model），图片功能不可用')
  }
  const baseURL = image.baseURL || cfg.baseURL
  const apiKey = image.apiKey || cfg.apiKey
  const provider = getProvider(baseURL, apiKey, 'chatgpt-plugin-image')
  if (typeof provider.imageModel !== 'function') {
    throw new Error('当前 @ai-sdk/openai-compatible 版本不支持 imageModel，请升级依赖')
  }
  return provider.imageModel(image.model)
}
