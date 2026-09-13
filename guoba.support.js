import Config from './config/config.js'

// 支持锅巴（Guoba）可视化配置
export function supportGuoba () {
  return {
    // 插件信息，将会显示在前端页面
    pluginInfo: {
      name: 'chatgpt-plugin',
      title: 'ChatGPT-Plugin（AI SDK 版）',
      author: '@ikechan8370',
      authorLink: 'https://github.com/ikechan8370',
      link: 'https://github.com/fqxue/chat2-plugin',
      isV3: true,
      isV2: false,
      description: '基于 Vercel AI SDK（ai）的极简对话插件，支持任意 OpenAI 兼容接口，@机器人 或前缀触发对话',
      icon: 'simple-icons:openai',
      iconColor: '#10a37f'
    },
    // 配置项信息
    configInfo: {
      // 配置项 schemas
      schemas: [
        {
          field: 'dividerApi',
          label: '模型接口',
          component: 'Divider'
        },
        {
          field: 'apiKey',
          label: 'API Key',
          component: 'InputPassword',
          bottomHelpMessage: 'OpenAI 兼容接口的 API Key（必填）',
          componentProps: {
            placeholder: 'sk-...'
          }
        },
        {
          field: 'baseURL',
          label: '接口地址（baseURL）',
          component: 'Input',
          bottomHelpMessage: '任意 OpenAI 兼容接口地址，例如 https://api.openai.com/v1',
          componentProps: {
            placeholder: 'https://api.openai.com/v1'
          }
        },
        {
          field: 'model',
          label: '默认模型',
          component: 'Input',
          bottomHelpMessage: '模型 ID，也可通过 #chatgpt模型 <模型ID> 指令临时切换',
          componentProps: {
            placeholder: 'gpt-4o-mini'
          }
        },
        {
          field: 'dividerChat',
          label: '对话',
          component: 'Divider'
        },
        {
          field: 'systemPrompt',
          label: '系统提示词',
          component: 'InputTextArea',
          componentProps: {
            rows: 4,
            placeholder: 'You are a helpful assistant.'
          },
          bottomHelpMessage: '留空则不发送 system 消息'
        },
        {
          field: 'maxHistory',
          label: '会话历史上限',
          component: 'InputNumber',
          bottomHelpMessage: '每个会话（群聊/私聊）在内存中保留的最大消息条数',
          componentProps: {
            min: 2,
            max: 200,
            precision: 0
          }
        },
        {
          field: 'maxTokens',
          label: '最大输出 Token',
          component: 'InputNumber',
          bottomHelpMessage: '0 表示不限制，由服务端决定',
          componentProps: {
            min: 0,
            precision: 0
          }
        },
        {
          field: 'temperature',
          label: '采样温度',
          component: 'InputNumber',
          bottomHelpMessage: '-1 表示不传该参数，使用服务端默认值；一般 0 ~ 2',
          componentProps: {
            min: -1,
            max: 2,
            step: 0.1,
            precision: 1
          }
        },
        {
          field: 'timeout',
          label: '请求超时（毫秒）',
          component: 'InputNumber',
          bottomHelpMessage: '单次对话请求的超时时间',
          componentProps: {
            min: 1000,
            step: 1000,
            precision: 0
          }
        },
        {
          field: 'dividerTrigger',
          label: '触发方式',
          component: 'Divider'
        },
        {
          field: 'toggleMode',
          label: '触发模式',
          component: 'RadioGroup',
          bottomHelpMessage: 'at：@机器人触发；prefix：前缀触发（at 模式下前缀同样生效）',
          componentProps: {
            options: [
              { label: '@触发', value: 'at' },
              { label: '前缀触发', value: 'prefix' }
            ]
          }
        },
        {
          field: 'togglePrefix',
          label: '触发前缀',
          component: 'Input',
          bottomHelpMessage: 'prefix 模式下的触发前缀',
          componentProps: {
            placeholder: '#chat'
          }
        },
        {
          field: 'dividerBym',
          label: '伪人模式（BYM）',
          component: 'Divider'
        },
        {
          field: 'bym.enable',
          label: '启用伪人模式',
          component: 'Switch',
          bottomHelpMessage: '开启后机器人以普通群友身份概率参与群聊'
        },
        {
          field: 'bym.speakingMode',
          label: '发言策略',
          component: 'RadioGroup',
          bottomHelpMessage: 'reply：回复触发消息；contextual：结合最近群聊记录自主发言',
          componentProps: {
            options: [
              { label: '回复触发消息', value: 'reply' },
              { label: '结合群聊上下文', value: 'contextual' }
            ]
          }
        },
        {
          field: 'bym.hit',
          label: '必中触发词',
          component: 'Input',
          bottomHelpMessage: '消息包含任一关键词必定触发伪人发言，多个词用逗号分隔',
          componentProps: {
            placeholder: 'bym,伪人'
          }
        },
        {
          field: 'bym.probability',
          label: '随机触发概率',
          component: 'InputNumber',
          bottomHelpMessage: '不含必中关键词时每条群消息的触发概率（0 ~ 1），建议不超过 0.05',
          componentProps: {
            min: 0,
            max: 1,
            step: 0.01,
            precision: 2
          }
        },
        {
          field: 'bym.systemPrompt',
          label: '伪人系统提示词',
          component: 'InputTextArea',
          componentProps: {
            rows: 4
          },
          bottomHelpMessage: '伪人发言的人设，留空则不发送 system 消息'
        },
        {
          field: 'bym.contextualPrompt',
          label: '自主发言指令',
          component: 'InputTextArea',
          componentProps: {
            rows: 4
          },
          bottomHelpMessage: 'contextual 策略下发给模型的本轮指令'
        },
        {
          field: 'bym.contextLength',
          label: '上下文条数',
          component: 'InputNumber',
          bottomHelpMessage: 'contextual 策略下携带的最近群聊消息条数',
          componentProps: {
            min: 1,
            max: 50,
            precision: 0
          }
        },
        {
          field: 'bym.maxTokens',
          label: '伪人最大输出 Token',
          component: 'InputNumber',
          bottomHelpMessage: '0 表示不限制；可设置较小值（如 200）控制发言长度',
          componentProps: {
            min: 0,
            precision: 0
          }
        },
        {
          field: 'bym.temperature',
          label: '伪人采样温度',
          component: 'InputNumber',
          bottomHelpMessage: '-1 表示使用服务端默认值；调高可让发言更随机',
          componentProps: {
            min: -1,
            max: 2,
            step: 0.1,
            precision: 1
          }
        },
        {
          field: 'dividerImage',
          label: '图片生成/编辑',
          component: 'Divider'
        },
        {
          field: 'image.model',
          label: '图片模型',
          component: 'Input',
          bottomHelpMessage: '图片模型 ID（走 OpenAI images 兼容接口），留空则不启用画图功能',
          componentProps: {
            placeholder: 'gpt-image-1'
          }
        },
        {
          field: 'image.baseURL',
          label: '图片接口地址',
          component: 'Input',
          bottomHelpMessage: '留空则复用上方「接口地址（baseURL）」',
          componentProps: {
            placeholder: 'https://api.openai.com/v1'
          }
        },
        {
          field: 'image.apiKey',
          label: '图片接口 API Key',
          component: 'InputPassword',
          bottomHelpMessage: '留空则复用上方 API Key',
          componentProps: {
            placeholder: 'sk-...'
          }
        },
        {
          field: 'image.size',
          label: '图片尺寸',
          component: 'Input',
          bottomHelpMessage: '格式 {width}x{height}，如 1024x1024；留空使用服务端默认',
          componentProps: {
            placeholder: '1024x1024'
          }
        },
        {
          field: 'image.timeout',
          label: '图片请求超时（毫秒）',
          component: 'InputNumber',
          bottomHelpMessage: '单次图片生成/编辑请求的超时时间；图片接口通常较慢，建议 180000 以上',
          componentProps: {
            min: 10000,
            step: 10000,
            precision: 0
          }
        },
        {
          field: 'image.asTool',
          label: '作为对话工具',
          component: 'Switch',
          bottomHelpMessage: '开启后对话模型可自主调用画图工具（如用户聊天中要求画图时）'
        },
        {
          field: 'dividerWallpaper',
          label: '壁纸',
          component: 'Divider'
        },
        {
          field: 'wallpaper.enable',
          label: '启用壁纸功能',
          component: 'Switch',
          bottomHelpMessage: '开启后可用 #壁纸 查看最新壁纸、#壁纸下载 下载原图，对话模型也可调用壁纸工具'
        },
        {
          field: 'wallpaper.previewCount',
          label: '预览缩略图数量',
          component: 'InputNumber',
          bottomHelpMessage: '#壁纸 列表时随文本发送的缩略图数量，0 为只发文字列表',
          componentProps: {
            min: 0,
            max: 9,
            precision: 0
          }
        },
        {
          field: 'wallpaper.pageSize',
          label: '每页壁纸数量',
          component: 'InputNumber',
          bottomHelpMessage: '每页展示的壁纸条数',
          componentProps: {
            min: 1,
            max: 30,
            precision: 0
          }
        }
      ],
      // 获取配置数据方法（用于前端填充显示数据）
      getConfigData () {
        const snap = Config.snapshot()
        // hit 是数组，前端输入框需要字符串
        return {
          ...snap,
          bym: {
            ...snap.bym,
            hit: Array.isArray(snap.bym?.hit) ? snap.bym.hit.join(',') : (snap.bym?.hit ?? '')
          }
        }
      },
      // 设置配置的方法（前端点确定后调用的方法）
      setConfigData (data, { Result }) {
        try {
          const keys = [
            'apiKey', 'baseURL', 'model', 'systemPrompt',
            'toggleMode', 'togglePrefix', 'maxHistory', 'maxTokens',
            'temperature', 'timeout'
          ]
          for (const key of keys) {
            if (data[key] !== undefined && Config[key] !== data[key]) {
              Config[key] = data[key]
            }
          }
          // 伪人模式（bym.*）
          const bymKeys = [
            'enable', 'speakingMode', 'systemPrompt', 'contextualPrompt',
            'contextLength', 'maxTokens', 'temperature', 'probability'
          ]
          for (const key of bymKeys) {
            const value = data[`bym.${key}`]
            if (value !== undefined && Config.bym[key] !== value) {
              Config.bym[key] = value
            }
          }
          // hit：前端传字符串，按分隔符拆为数组
          if (data['bym.hit'] !== undefined) {
            const hit = String(data['bym.hit'] ?? '')
              .split(/[,，、;；|\s]+/)
              .map(word => word.trim())
              .filter(Boolean)
            if (JSON.stringify(Config.bym.hit) !== JSON.stringify(hit)) {
              Config.bym.hit = hit
            }
          }
          // 图片生成/编辑（image.*）
          const imageKeys = ['model', 'baseURL', 'apiKey', 'size', 'asTool', 'timeout']
          for (const key of imageKeys) {
            const value = data[`image.${key}`]
            if (value !== undefined && Config.image[key] !== value) {
              Config.image[key] = value
            }
          }
          // 壁纸（wallpaper.*）
          const wallpaperKeys = ['enable', 'previewCount', 'pageSize']
          for (const key of wallpaperKeys) {
            const value = data[`wallpaper.${key}`]
            if (value !== undefined && Config.wallpaper[key] !== value) {
              Config.wallpaper[key] = value
            }
          }
          Config.save()
          return Result.ok({}, '保存成功~')
        } catch (err) {
          logger?.error?.(`[chatgpt-plugin] 锅巴保存配置失败：${err?.message || err}`)
          return Result.error(`保存失败：${err?.message || err}`)
        }
      }
    }
  }
}
