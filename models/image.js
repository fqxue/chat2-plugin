import { generateImage } from 'ai'
import Config from '../config/config.js'
import { getImageModel } from './provider.js'

/**
 * 图片生成/编辑的共享核心：
 * - 直接指令调用（apps/image.js）
 * - 作为 agent 工具供对话模型调用（apps/chat.js）
 * 复用同一个函数，保证两种入口行为一致。
 */

/** 将调用方传入的图片引用归一化为 ai 可接受的 DataContent */
function toDataContent (img) {
  const s = String(img)
  // URL / data URL 直接透传，SDK 会自行获取
  if (/^(https?|data|file):/i.test(s)) {
    return s
  }
  // 裸 base64 包装为 data URL
  return `data:image/png;base64,${s}`
}

/**
 * 生成或编辑图片
 * @param {object} opts
 * @param {string} opts.prompt 图片描述 / 编辑指令
 * @param {string[]} [opts.images] 参考图片（URL 或 base64），提供时走编辑流程
 * @returns {Promise<string>} 图片 base64
 */
export async function generateImageBase64 ({ prompt, images = [] }) {
  const cfg = Config.snapshot()
  const imageCfg = cfg.image || {}
  if (!imageCfg.model) {
    throw new Error('未启用图片功能，请联系主人配置 image.model')
  }

  const params = {
    model: getImageModel(),
    abortSignal: AbortSignal.timeout(cfg.timeout || 120000)
  }

  if (images.length > 0) {
    // 编辑模式：图片输入 + 文字指令
    params.prompt = {
      images: images.map(toDataContent),
      text: prompt || '请编辑这张图片'
    }
  } else {
    if (!prompt) {
      throw new Error('缺少图片描述（prompt）')
    }
    params.prompt = prompt
  }
  if (imageCfg.size) {
    params.size = imageCfg.size
  }

  const { image } = await generateImage(params)
  if (!image?.base64) {
    throw new Error('图片模型没有返回图片数据')
  }
  return image.base64
}
