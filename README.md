# chatgpt-plugin（Vercel AI SDK 版）

基于 [Vercel AI SDK](https://github.com/vercel/ai)（`ai` 包）彻底重构的极简 Yunzai-Bot / Miao-Yunzai 对话插件。

v4 起插件不再依赖 `chaite` 内核及自研的向量库、记忆、RAG、管理面板等模块，仅保留使用 AI SDK 最容易直接实现的核心能力：

- **对话**：`@机器人` 或前缀触发，调用 `generateText` 完成多轮对话。
- **多模态输入**：消息带图片时，通过 AI SDK 的 `image` content part 直接传给视觉模型。
- **会话历史**：按群聊 / 私聊维度在内存中保留最近 N 条历史。
- **伪人模式（BYM）**：以普通群友身份概率参与群聊，支持「回复触发消息」与「结合群聊上下文自主发言」两种策略。
- **管理指令**：重置会话、切换模型、查看帮助。
- **OpenAI 兼容接入**：通过 `@ai-sdk/openai-compatible` 支持任意 OpenAI 兼容接口。
- **锅巴配置**：支持通过锅巴（Guoba）插件可视化修改全部配置。

## 安装

```bash
cd plugins
git clone <本仓库> chatgpt-plugin
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
| `@机器人 + 内容`（或 `#chat + 内容`） | 对话 |
| `#chatgpt重置` | 清空当前会话历史 |
| `#chatgpt重置全部` | 清空所有会话历史 |
| `#chatgpt模型 <模型ID>` | 切换默认模型 |
| `#chatgpt帮助` | 查看帮助 |

管理指令默认仅主人可用。

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

## 项目结构

```
index.js               # 插件入口，加载 apps
apps/chat.js           # 对话（ai 的 generateText）
apps/bym.js            # 伪人模式（概率触发发言）
apps/recorder.js       # 群聊记录器（contextual 策略的上下文来源）
apps/management.js     # 管理指令
models/provider.js     # createOpenAICompatible 创建模型
models/history.js      # 内存会话历史
models/groupLog.js     # 群聊消息环形缓冲
config/config.js       # 配置加载与保存
guoba.support.js       # 锅巴可视化配置支持
```

## License

[GPL-3.0](./LICENSE)
