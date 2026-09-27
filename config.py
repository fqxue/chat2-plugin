"""chat2 插件配置:移植自 Yunzai chatgpt-plugin 的 config/config.js。

首次启动在 plugins/chat2/config/config.yaml 生成带注释的默认配置,
加载时与默认值做一层深合并,避免旧配置缺字段时丢默认值。
"""

import os
from pathlib import Path
from typing import Any

import yaml

PLUGIN_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG_DIR = PLUGIN_ROOT / "config"
# 打包/容器等只读部署下,可用 CHAT2_CONFIG_FILE 把配置放到可写目录
_ENV_CONFIG_FILE = os.environ.get("CHAT2_CONFIG_FILE", "").strip()
CONFIG_FILE = (
    Path(_ENV_CONFIG_FILE).expanduser()
    if _ENV_CONFIG_FILE
    else DEFAULT_CONFIG_DIR / "config.yaml"
)
CONFIG_DIR = CONFIG_FILE.parent

DEFAULT_CONFIG: dict[str, Any] = {
    # OpenAI 兼容接口的 API Key(必填)
    "apiKey": "",
    # OpenAI 兼容接口的 baseURL,可指向任何兼容服务
    "baseURL": "https://api.openai.com/v1",
    # 默认模型
    "model": "gpt-4o-mini",
    # 系统提示词,留空则不发送
    "systemPrompt": "You are a helpful assistant.",
    # 触发方式:at(@机器人,QQ 官方适配器由平台原生 @ 承担)或 prefix(前缀)
    "toggleMode": "at",
    # prefix 模式下的触发前缀
    "togglePrefix": "#chat",
    # 每个会话保留的最大历史消息条数
    "maxHistory": 20,
    # 视频解析体积上限(MB),抖音/B站统一生效;0 表示不限制。
    # QQ 富媒体对单条视频有体积上限,超限会发送失败,这里提前拦下
    "maxVideoSizeMb": 30,
    # 最大输出 token,0 表示不限制
    "maxTokens": 0,
    # 采样温度,-1 表示不传该参数(使用服务端默认值)
    "temperature": -1,
    # 请求超时时间(毫秒)
    "timeout": 120000,
    # 图片生成/编辑
    "image": {
        # 图片模型 ID,留空则不启用图片功能
        "model": "",
        # 图片接口的 apiKey,留空则复用主配置
        "apiKey": "",
        # 图片接口的 baseURL,留空则复用主配置
        "baseURL": "",
        # 生成尺寸,格式 {width}x{height}(如 1024x1024),留空使用服务端默认
        "size": "",
        # 单次图片生成/编辑请求的超时时间(毫秒),图片接口通常较慢
        "timeout": 180000,
        # 是否把图片生成注册为 agent 工具供对话模型调用
        "asTool": True,
    },
    # 壁纸功能(调用云开发接口获取最新壁纸)
    "wallpaper": {
        # 开关
        "enable": True,
        # 每页壁纸数量
        "pageSize": 9,
    },
    # 抖音解析 Cookie(可选,抖音风控时填写浏览器 Cookie)
    "douyin": {
        "cookie": "",
    },
}

# 需要与默认值深合并的嵌套配置段
_NESTED_KEYS = ("image", "wallpaper", "douyin")

_CONFIG_HEADER = """\
# chat2 插件配置文件(移植自 Yunzai chatgpt-plugin,基于 NoneBot2)
# apiKey 与 baseURL 支持任何 OpenAI 兼容接口
"""


class Chat2Config:
    """当前生效的插件配置,可直接读写属性,#ai模型 等指令运行时可修改。"""

    def __init__(self) -> None:
        self._data: dict[str, Any] = {}
        self.load()

    def _defaults(self) -> dict[str, Any]:
        return {k: (dict(v) if isinstance(v, dict) else v)
                for k, v in DEFAULT_CONFIG.items()}

    def load(self) -> None:
        from nonebot import logger

        try:
            CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            # 只读环境(如打包进 site-packages)下目录建不出来,退化为纯默认配置
            logger.warning(f"[chat2] 配置目录不可用({CONFIG_DIR}): {err},将使用默认配置")
            self._data = self._defaults()
            return

        if not CONFIG_FILE.exists():
            # 全新安装:生成一份带注释的默认配置文件
            try:
                CONFIG_FILE.write_text(
                    _CONFIG_HEADER + yaml.safe_dump(
                        DEFAULT_CONFIG, allow_unicode=True, sort_keys=False
                    ),
                    encoding="utf-8",
                )
            except OSError as err:
                logger.warning(f"[chat2] 无法写入配置文件({CONFIG_FILE}): {err}")
            self._data = self._defaults()
            return

        loaded = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8"))
        data = self._defaults()
        if isinstance(loaded, dict):
            for key, value in loaded.items():
                if key not in DEFAULT_CONFIG:
                    # 配置文件里已废弃的键不再带回,避免又被写回配置文件
                    continue
                if key in _NESTED_KEYS and isinstance(value, dict):
                    data[key] = {**DEFAULT_CONFIG[key], **value}
                else:
                    data[key] = value
        self._data = data

    def save(self) -> bool:
        """将当前配置持久化到 config.yaml,写入失败返回 False(如只读部署)。"""
        from nonebot import logger

        try:
            CONFIG_FILE.write_text(
                _CONFIG_HEADER + yaml.safe_dump(
                    self._data, allow_unicode=True, sort_keys=False
                ),
                encoding="utf-8",
            )
        except OSError as err:
            logger.error(f"[chat2] 配置写入失败({CONFIG_FILE}): {err}")
            return False
        return True

    def snapshot(self) -> dict[str, Any]:
        """读取生效的配置项(可被运行时覆盖,如 #ai模型 指令)。"""
        return {
            key: (dict(value) if isinstance(value, dict) else value)
            for key, value in self._data.items()
        }

    def __getattr__(self, name: str) -> Any:
        try:
            return self._data[name]
        except KeyError:
            raise AttributeError(name) from None

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_"):
            super().__setattr__(name, value)
        else:
            self._data[name] = value


Config = Chat2Config()
