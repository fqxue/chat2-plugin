import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import Config from '../config/config.js'

/**
 * 基于 Vercel AI SDK 的模型提供方。
 * 使用 @ai-sdk/openai-compatible 适配任意 OpenAI 兼容接口，
 * 返回的模型可直接传给 ai 包的 generateText / streamText 等函数。
 */

let cached = { baseURL: '', apiKey: '', provider: null }

function getProvider (baseURL, apiKey) {
  if (!baseURL || !apiKey) {
    throw new Error('尚未配置 apiKey 或 baseURL，请编辑 plugins/chatgpt-plugin/config/config.yaml 后重启')
  }
  if (!cached.provider || cached.baseURL !== baseURL || cached.apiKey !== apiKey) {
    cached = {
      baseURL,
      apiKey,
      provider: createOpenAICompatible({ name: 'chatgpt-plugin', baseURL, apiKey })
    }
  }
  return cached.provider
}

/**
 * 获取一个 LanguageModel 实例
 * @param {string} [modelId] 模型 ID，默认取配置中的 model
 */
export function getModel (modelId) {
  const cfg = Config.snapshot()
  const provider = getProvider(cfg.baseURL, cfg.apiKey)
  const id = modelId || cfg.model
  // 兼容不同版本的 @ai-sdk/openai-compatible
  if (typeof provider.chatModel === 'function') {
    return provider.chatModel(id)
  }
  return provider(id)
}
