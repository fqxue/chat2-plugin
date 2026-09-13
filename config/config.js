import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const configDir = path.join(pluginRoot, 'config')

const DEFAULT_CONFIG = {
  // OpenAI 兼容接口的 API Key（必填）
  apiKey: '',
  // OpenAI 兼容接口的 baseURL，可指向任何兼容服务
  baseURL: 'https://api.openai.com/v1',
  // 默认模型
  model: 'gpt-4o-mini',
  // 系统提示词，留空则不发送
  systemPrompt: 'You are a helpful assistant.',
  // 触发方式：at（@机器人）或 prefix（前缀）
  toggleMode: 'at',
  // prefix 模式下的触发前缀
  togglePrefix: '#chat',
  // 每个会话保留的最大历史消息条数
  maxHistory: 20,
  // 最大输出 token，0 表示不限制
  maxTokens: 0,
  // 采样温度，-1 表示不传该参数（使用服务端默认值）
  temperature: -1,
  // 请求超时时间（毫秒）
  timeout: 120000
}

class ChatGPTConfig {
  version = '4.0.0'

  constructor () {
    Object.assign(this, DEFAULT_CONFIG)
    this._load()
  }

  _load () {
    const jsonPath = path.join(configDir, 'config.json')
    const yamlPath = path.join(configDir, 'config.yaml')
    let loaded = null
    if (fs.existsSync(jsonPath)) {
      loaded = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    } else if (fs.existsSync(yamlPath)) {
      loaded = yaml.load(fs.readFileSync(yamlPath, 'utf-8'))
    } else {
      // 全新安装：生成一份带注释的默认配置文件
      const template = [
        '# chatgpt-plugin 配置文件（基于 Vercel AI SDK）',
        '# apiKey 与 baseURL 支持任何 OpenAI 兼容接口',
        yaml.dump(DEFAULT_CONFIG, { lineWidth: -1 })
      ].join('\n')
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(yamlPath, template, 'utf-8')
      global.logger?.info?.(`[chatgpt-plugin] 已生成默认配置文件：${yamlPath}，请填写 apiKey 后重启`)
      return
    }
    if (loaded && typeof loaded === 'object') {
      Object.assign(this, loaded)
    }
  }

  /** 读取生效的配置项（可被运行时覆盖，如 #chatgpt模型 指令） */
  snapshot () {
    return {
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      model: this.model,
      systemPrompt: this.systemPrompt,
      toggleMode: this.toggleMode,
      togglePrefix: this.togglePrefix,
      maxHistory: this.maxHistory,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      timeout: this.timeout
    }
  }
}

const Config = new ChatGPTConfig()
export default Config
export { Config, pluginRoot }
