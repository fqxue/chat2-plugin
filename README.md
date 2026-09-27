# chat2(NoneBot2 版)

[NoneBot2](https://nonebot.dev/) 版的 AI 对话插件,移植自 Yunzai 的 [chat2-plugin](https://github.com/fqxue/chat2-plugin)(GPL-3.0),适配 [nonebot-adapter-qq](https://github.com/nonebot/adapter-qq)(QQ 官方机器人开放平台,不是 go-cqhttp)。

功能一览:

- 多轮对话,支持带图提问(图片直接交给视觉模型)
- 对话中可调用 agent 工具:生成/编辑图片、浏览与下载壁纸
- 抖音分享链接解析(本地签名实现,不依赖浏览器)
- Bilibili 视频链接解析(yt-dlp 选流 + 内置 ffmpeg 合并)
- 壁纸预览图 + 回调按钮交互

## 环境要求

- Python 3.10+
- nonebot2(建议 `fastapi` + `httpx` + `websockets` driver)
- nonebot-adapter-qq >= 1.7.2
- openai >= 1.50、pillow >= 10、pyyaml >= 6、cryptography >= 42
- yt-dlp、imageio-ffmpeg(仅 Bilibili 解析用到)

## 安装

把本仓库的全部文件放到你的 NoneBot2 项目的 `plugins/chat2/`:

```text
your-bot/
└── plugins/
    └── chat2/          # 本仓库内容
```

插件目录由 `[tool.nonebot] plugin_dirs = ["./plugins"]` 自动发现,不需要额外注册。再安装上面列出的依赖即可。

## 配置

首次启动会自动生成 `config/config.yaml`,字段与注释见 [`config/config.example.yaml`](config/config.example.yaml)。

必填:

| 配置 | 说明 |
| --- | --- |
| `apiKey` | OpenAI 兼容接口的 API Key |
| `baseURL` | OpenAI 兼容接口地址 |
| `model` | 对话模型 ID |

常用:

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `toggleMode` | `at` | `at`(群里 @机器人)或 `prefix`(前缀触发) |
| `togglePrefix` | `#chat` | 前缀模式的触发词,`at` 模式下也可用它触发 |
| `maxHistory` | `20` | 每个会话保留的历史条数 |
| `timeout` | `120000` | 对话请求超时(毫秒) |
| `maxTokens` | `0` | 最大输出 token,0 表示不限制 |
| `temperature` | `-1` | 采样温度,-1 表示用服务端默认值 |
| `maxVideoSizeMb` | `30` | 抖音/B站视频体积上限(MB),0 表示不限制 |
| `image.model` | 空 | 图片模型 ID,**留空即关闭图片功能** |
| `image.apiKey` / `image.baseURL` | 空 | 图片接口独立配置,留空则复用主配置 |
| `image.size` | 空 | 生成尺寸,如 `1024x1024` |
| `image.asTool` | `true` | 是否把图片生成注册为对话模型的工具 |
| `wallpaper.enable` | `true` | 壁纸功能开关 |
| `wallpaper.pageSize` | `9` | 每页壁纸数量 |
| `douyin.cookie` | 空 | 抖音风控时填入浏览器 Cookie |

`config/config.yaml` 含密钥,已在 `.gitignore` 中排除,请不要提交。

## 指令

群里使用需要同时 @机器人;私聊直接发送即可。

| 指令 | 说明 |
| --- | --- |
| @机器人 + 内容 / 私聊直接发 | 多轮对话,支持带图提问;也可以直接说"画一只猫""来一张壁纸"调用工具 |
| `#ai重置` / `#ai重置全部` | 清空当前 / 全部会话历史(仅主人) |
| `#ai模型 <模型ID>` | 切换默认模型并写回配置文件(仅主人) |
| `#ai帮助` | 查看帮助(所有人可用) |
| `#设置抖音cookie <cookie>` | 设置抖音 Cookie 并持久化(仅主人) |
| `#画图 <描述>` | 文生图(需配置 `image.model`) |
| `#改图 <指令>` | 编辑图片(附带或引用一张图片发送,别名 `#编辑图片` / `#P图`) |
| `#壁纸 [页码]` | 发送壁纸预览图 |
| `#下载1` / `#下载1,2` | 按预览图上的编号发送原图(可跨页) |
| 点预览图下方的按钮 | 直接发送该编号的原图,或翻页 |
| 抖音分享链接 | 自动解析:视频直接发送,图文逐张发图(最多 9 张) |
| Bilibili 视频链接 | 支持 `b23.tv`、`BV`、`av` 链接,解析后发送视频 |

`#ai` 指令同时接受 `#chatgpt` 别名。

## 群聊注意事项

- QQ 官方平台只投递 @机器人的群消息,所以群里每条指令都要 @机器人;私聊无法 @,因此私聊始终响应。
- **壁纸按钮**依赖 `INTERACTION_CREATE` 事件,需要在机器人的 `intent` 里同时订阅 `interaction`,否则预览图和 `#下载` 照常可用、只是没有按钮。
- 主人指令比对的是 **openid 而非 QQ 号**,且私聊/群聊/正式/沙箱环境下的 openid 各不相同,请按实际收到的 id 配置 `SUPERUSERS`。
- 长耗时的图片生成、视频解析都在异步流程里完成,不会阻塞事件循环;但生成图片可能耗时数分钟,请相应放宽 `image.timeout` 与下游网关超时。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `__init__.py` | 插件入口:检查 `apiKey` 并导入各 matcher 完成注册 |
| `matcher_manage.py` | `#ai重置/模型/帮助`、`#设置抖音cookie`(priority 1) |
| `matcher_wallpaper.py` | `#壁纸`、`#下载` 与壁纸按钮回调(priority 1/2) |
| `matcher_image.py` | `#画图`、`#改图`(priority 3) |
| `matcher_douyin.py` / `matcher_bilibili.py` | 分享链接解析(priority 4) |
| `matcher_chat.py` | 兜底对话入口,含工具调用循环(priority 10) |
| `chat_tool.py` | 对话模型的 agent 工具定义与执行 |
| `config.py` | 配置加载/深合并/持久化,`Config` 单例 |
| `llm.py` | `AsyncOpenAI` 客户端缓存与超时归一化 |
| `history.py` | 内存会话历史(群按 `group:{group_openid}`,私聊按 `user:{user_openid}`) |
| `media_send.py` | 统一的图片/视频发送(带一次重试)与限体积下载 |
| `image_core.py` | 图片生成/编辑核心,两种入口共用 |
| `wallpaper_core.py` | 云开发壁纸接口(签名请求 + AES 解密 + 列表缓存) |
| `wallpaper_render.py` | Pillow 网格预览图与回调按钮 |
| `douyin_core.py` | 抖音分享链接解析 |
| `bilibili_core.py` | Bilibili 选流与下载(yt-dlp / ffmpeg) |
| `signing/` | 抖音本地签名(a-bogus、websign、SM3),见下 |

## 与 Yunzai 版的差异

- **伪人模式(BYM)已删除**:官方平台收不到群里未 @ 的消息。
- **`#ai更新` 已移除**。
- 壁纸预览图改由 Pillow 拼图生成(原版是 HTML 截图),按钮交互改为 QQ 官方回调按钮。
- 会话历史存储在内存中、按 openid 隔离(重启即清空),不再有落盘的上下文文件。
- 抖音签名改为本地实现(`signing/`:a-bogus、websign、SM3),不再依赖浏览器或第三方服务。
- 视频体积上限 `maxVideoSizeMb` 对抖音与 B站统一生效:优先挑体积合规的清晰度,下载中一旦超限立即中断。
- 图片生成/编辑可作为 agent 工具供对话模型调用,工具会把结果直接发给用户。

## 许可证

本插件派生自 [chat2-plugin](https://github.com/fqxue/chat2-plugin)(GPL-3.0),按 **GPL-3.0** 分发。

`signing/` 目录为 Apache-2.0 来源的本地签名实现,其许可证与声明见 [`signing/LICENSE`](signing/LICENSE) 与 [`signing/NOTICE.txt`](signing/NOTICE.txt)。
