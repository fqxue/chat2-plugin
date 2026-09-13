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
  timeout: 120000,
  // 伪人模式（BYM）：以普通群友身份概率参与群聊
  bym: {
    // 开关
    enable: false,
    // 必定触发的关键词（消息包含任一关键词即触发）
    hit: ['bym'],
    // 不包含必中关键词时的随机触发概率（0 ~ 1）
    probability: 0.02,
    // 发言策略：reply 回复触发消息；contextual 结合群聊上下文自主发言
    speakingMode: 'reply',
    // contextual 模式下发送给模型的本轮指令
    contextualPrompt: '你现在不是在回复某一条特定消息，而是作为这个群里的一名普通群友自然参与当前聊天。请阅读下面的群聊上下文，选择一个自然的切入点发言，可以接续话题、补充信息、吐槽、提问或表达态度。不要解释任务，不要提及"上下文""指令""AI"或"机器人"，不要强行引用、@或逐句回答别人的消息。直接输出一段适合发到群里的自然发言。',
    // 伪人模式的人设系统提示词，留空则不发送
    systemPrompt: '你是这个 QQ 群里的一名普通群友。请用简短、口语化、自然的中文发言，像真人一样聊天。不要自我介绍，不要提及你是 AI 或机器人，不要使用 Markdown 格式，不要长篇大论，通常一两句话即可。',
    // contextual 模式下携带的最近群聊消息条数
    contextLength: 20,
    // 最大输出 token，0 表示不限制
    maxTokens: 0,
    // 采样温度，-1 表示使用服务端默认值
    temperature: -1
  },
  // 图片生成/编辑（基于 ai 的 generateImage）
  image: {
    // 图片模型 ID，留空则不启用图片功能
    model: '',
    // 图片接口的 apiKey，留空则复用主配置的 apiKey
    apiKey: '',
    // 图片接口的 baseURL，留空则复用主配置的 baseURL
    baseURL: '',
    // 生成尺寸，格式 {width}x{height}（如 1024x1024），留空使用服务端默认
    size: '',
    // 单次图片生成/编辑请求的超时时间（毫秒），图片接口通常较慢
    timeout: 180000,
    // 是否把图片生成注册为 agent 工具供对话模型调用
    asTool: true
  }
}

class ChatGPTConfig {
  version = '4.0.0'

  constructor () {
    Object.assign(this, DEFAULT_CONFIG)
    this._configFile = ''
    this._load()
  }

  _load () {
    const jsonPath = path.join(configDir, 'config.json')
    const yamlPath = path.join(configDir, 'config.yaml')
    let loaded = null
    if (fs.existsSync(jsonPath)) {
      this._configFile = jsonPath
      loaded = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    } else if (fs.existsSync(yamlPath)) {
      this._configFile = yamlPath
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
      this._configFile = yamlPath
      global.logger?.info?.(`[chatgpt-plugin] 已生成默认配置文件：${yamlPath}，请填写 apiKey 后重启`)
      return
    }
    if (loaded && typeof loaded === 'object') {
      Object.assign(this, loaded)
      // 嵌套配置做一层合并，避免旧配置文件缺字段时丢默认值
      if (loaded.bym && typeof loaded.bym === 'object') {
        this.bym = { ...DEFAULT_CONFIG.bym, ...loaded.bym }
      }
      if (loaded.image && typeof loaded.image === 'object') {
        this.image = { ...DEFAULT_CONFIG.image, ...loaded.image }
      }
    }
  }

  /**
   * 将当前配置持久化到文件（供锅巴等外部配置界面保存使用）
   * 优先写回已存在的配置文件，否则写 config.yaml
   */
  save () {
    const jsonPath = path.join(configDir, 'config.json')
    const yamlPath = path.join(configDir, 'config.yaml')
    const target = this._configFile || yamlPath
    fs.mkdirSync(configDir, { recursive: true })
    const data = this.snapshot()
    if (target === jsonPath) {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8')
    } else {
      fs.writeFileSync(yamlPath, yaml.dump(data, { lineWidth: -1 }), 'utf-8')
      this._configFile = yamlPath
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
      timeout: this.timeout,
      bym: { ...this.bym },
      image: { ...this.image }
    }
  }
}

const Config = new ChatGPTConfig()
export default Config
export { Config, pluginRoot }
