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
          component: 'TextArea',
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
        }
      ],
      // 获取配置数据方法（用于前端填充显示数据）
      getConfigData () {
        return Config.snapshot()
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
