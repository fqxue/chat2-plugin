"""chat2:移植自 Yunzai chatgpt-plugin(https://github.com/fqxue/chat2-plugin)的 NoneBot2 插件。

功能:OpenAI 兼容接口多轮对话(支持图片输入与 agent 工具)、#画图/#改图、
#壁纸/#下载、抖音/Bilibili 链接解析、#ai 管理指令。
"""

from nonebot import logger

from .config import CONFIG_FILE, Config

if not Config.apiKey:
    logger.warning(
        f"[chat2] 尚未配置 apiKey,对话功能不可用,请编辑 {CONFIG_FILE} 填写"
    )

# 导入各 matcher 子模块完成注册
from . import (  # noqa: E402,F401
    matcher_bilibili,
    matcher_chat,
    matcher_douyin,
    matcher_image,
    matcher_manage,
    matcher_wallpaper,
)
