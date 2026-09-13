# chatgpt-plugin（Vercel AI SDK 版）

基于 [Vercel AI SDK](https://github.com/vercel/ai)（`ai` 包）彻底重构的极简 Yunzai-Bot / Miao-Yunzai 对话插件。

v4 起插件不再依赖 `chaite` 内核及自研的向量库、记忆、RAG、管理面板等模块，仅保留使用 AI SDK 最容易直接实现的核心能力：

- **对话**：`@机器人` 或前缀触发，调用 `generateText` 完成多轮对话。
- **多模态输入**：消息带图片时，通过 AI SDK 的 `image` content part 直接传给视觉模型。
- **会话历史**：按群聊 / 私聊维度在内存中保留最近 N 条历史。
- **伪人模式（BYM）**：以普通群友身份概率参与群聊，支持「回复触发消息」与「结合群聊上下文自主发言」两种策略。
- **图片生成/编辑**：基于 `ai` 的 `generateImage`，支持 `#画图` / `#改图` 直接调用；同时作为 agent 工具注册给对话模型，聊天中可自主画图。
- **管理指令**：重置会话、切换模型、更新插件、查看帮助。
- **OpenAI 兼容接入**：通过 `@ai-sdk/openai-compatible` 支持任意 OpenAI 兼容接口。
- **锅巴配置**：支持通过锅巴（Guoba）插件可视化修改全部配置。

## 安装

```bash
cd plugins
git clone https://github.com/fqxue/chat2-plugin.git chatgpt-plugin
cd chatgpt-plugin
pnpm install   # 或 npm install
```

重启 Yunzai 后，首次启动会在 `plugins/chatgpt-plugin/config/` 下生成默认 `config.yaml`。

## 配置

编辑 `config/config.yaml`：

```yaml
apiKey: sk-xxx                        # 必填
baseURL: https://api.openai.com/v1    # 任意 OpenAI 兼容接口
model: gpt-4o-mini
systemPrompt: You are a helpful assistant.
toggleMode: at        # at（@触发）或 prefix（前缀触发）
togglePrefix: '#chat'
maxHistory: 20
maxTokens: 0          # 0 表示不限制
temperature: -1       # -1 表示使用服务端默认值
timeout: 120000
```

## 指令

| 指令 | 说明 |
| --- | --- |
| 私聊直接发送内容；群聊 `@机器人 + 内容`（或 `#chat + 内容`） | 对话 |
| `#chatgpt重置` | 清空当前会话历史 |
| `#chatgpt重置全部` | 清空所有会话历史 |
| `#chatgpt模型 <模型ID>` | 切换默认模型 |
| `#画图 <描述>` | 文生图（需配置 `image.model`） |
| `#改图 <指令>` | 编辑图片：附带图片或引用一条含图片的消息发送 |
| `#chatgpt更新` | git 拉取最新代码，更新后重启 Yunzai 生效 |
| `#chatgpt帮助` | 查看帮助 |

管理指令默认仅主人可用；画图指令所有人可用。

## 图片生成/编辑

在 `config.yaml` 的 `image` 段（或锅巴界面）配置：

```yaml
image:
  model: gpt-image-1     # 图片模型 ID，留空则不启用
  apiKey: ''             # 留空则复用主配置
  baseURL: ''            # 留空则复用主配置
  size: '1024x1024'      # 可选，留空使用服务端默认
  asTool: true           # 作为 agent 工具供对话模型调用
```

两种使用方式共用同一实现（`models/image.js`）：

1. **直接指令**：`#画图 一只在山上徒步的戴黑帽的泰迪熊`；编辑时附带图片或引用含图消息发 `#改图 把背景换成海边`。
2. **Agent 工具**：`asTool: true` 时，对话模型可通过 `generate_image` 工具自主生成/编辑图片，图片会跟在文字回复后发送。

## 伪人模式（BYM）

在 `config.yaml` 的 `bym` 段（或锅巴界面）开启：

```yaml
bym:
  enable: true
  hit: ['bym']          # 必中触发词，消息包含即触发
  probability: 0.02     # 随机触发概率（0 ~ 1）
  speakingMode: reply   # reply：回复触发消息；contextual：结合群聊上下文自主发言
  contextLength: 20     # contextual 策略携带的最近群聊消息条数
  systemPrompt: >-      # 伪人的人设
    你是这个 QQ 群里的一名普通群友……
  maxTokens: 0
  temperature: -1
```

- 普通对话指令优先生效，伪人模式不会抢占 `#` 开头的命令。
- `contextual` 策略需要一个群聊记录器在内存中维护最近消息（插件已内置，仅在开启时记录）。
- 触发规则：私聊始终响应；群聊在 `at` 模式下需 @机器人 或使用前缀，`prefix` 模式下仅前缀触发。未配置 `apiKey` 时触发对话会收到提示。

## 项目结构

```
index.js               # 插件入口，加载 apps
apps/chat.js           # 对话（ai 的 generateText + agent 工具）
apps/image.js          # 图片生成/编辑指令（ai 的 generateImage）
apps/bym.js            # 伪人模式（概率触发发言）
apps/recorder.js       # 群聊记录器（contextual 策略的上下文来源）
apps/management.js     # 管理指令
models/provider.js     # createOpenAICompatible 创建对话/图像模型
models/image.js        # 图片生成/编辑共享核心
models/history.js      # 内存会话历史
models/groupLog.js     # 群聊消息环形缓冲
config/config.js       # 配置加载与保存
guoba.support.js       # 锅巴可视化配置支持
```

## License

[GPL-3.0](./LICENSE)
