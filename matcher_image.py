"""#画图 / #改图 指令,移植自 apps/image.js。"""

import base64
import re

from nonebot import on_regex
from nonebot.adapters.qq import QQMessageEvent
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .config import Config
from .image_core import collect_event_images, generate_image_base64
from .media_send import send_image

_DRAW_RE = r"^#画图\s+(.+)$"
_EDIT_RE = r"^#(?:改图|编辑图片|P图)\s*(.*)$"

_draw = on_regex(_DRAW_RE, priority=3, block=True)
_edit = on_regex(_EDIT_RE, priority=3, block=True)


async def _send_base64_image(matcher: Matcher, b64: str) -> None:
    buffer = base64.b64decode(b64)
    file_name = f"chat2.{len(buffer)}.png"
    await send_image(matcher, buffer, file_name)


@_draw.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    if not (Config.image or {}).get("model"):
        await matcher.finish("图片功能未启用,请联系主人配置 image.model")
    matched = re.match(_DRAW_RE, event.get_plaintext().strip())
    prompt = matched.group(1).strip() if matched else ""
    if not prompt:
        await matcher.finish("用法:#画图 <图片描述>")
    logger.info(f"[chat2] 图片生成: {prompt}")
    await matcher.send("正在生成图片,请稍候……")
    try:
        b64 = await generate_image_base64(prompt)
        await _send_base64_image(matcher, b64)
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 图片生成失败: {err}")
        await matcher.finish(f"图片生成失败:{err}")


@_edit.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    if not (Config.image or {}).get("model"):
        await matcher.finish("图片功能未启用,请联系主人配置 image.model")
    images = collect_event_images(event)
    if not images:
        await matcher.finish(
            "请附带图片或引用一条含图片的消息,再加编辑指令。"
            "例:回复图片消息发送「#改图 把背景换成海边」"
        )
    matched = re.match(_EDIT_RE, event.get_plaintext().strip())
    prompt = matched.group(1).strip() if matched else ""
    logger.info(f"[chat2] 图片编辑: {prompt or '(默认指令)'},参考图片 {len(images)} 张")
    await matcher.send("正在编辑图片,请稍候……")
    try:
        b64 = await generate_image_base64(prompt, images)
        await _send_base64_image(matcher, b64)
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 图片编辑失败: {err}")
        await matcher.finish(f"图片编辑失败:{err}")
