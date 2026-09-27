"""#壁纸 / #下载 指令,移植自 apps/wallpaper.js。

预览图之后附带一排回调按钮(每张壁纸一个),用户点按钮即可拿到对应原图,
按钮点击由下面的 INTERACTION_CREATE matcher 处理。
"""

import re

from nonebot import Bot, on_regex, on_type
from nonebot.adapters.qq import QQMessageEvent
from nonebot.adapters.qq.event import InteractionCreateEvent
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .config import Config
from .media_send import send_image
from .wallpaper_core import (
    fetch_wallpaper_buffer,
    get_wallpaper_original_urls,
    get_wallpaper_page,
)
from .wallpaper_render import (
    BUTTON_DATA_PREFIX,
    PAGE_BUTTON_PREFIX,
    send_wallpaper_preview,
)

_WALLPAPER_RE = r"^#壁纸(?:\s*(\d+))?$"
_DOWNLOAD_RE = r"^#下载\s*([0-9]+(?:[,，][0-9]+)*)$"

_wallpaper = on_regex(_WALLPAPER_RE, priority=2, block=True)
_download = on_regex(_DOWNLOAD_RE, priority=2, block=True)


def _button_data(event: InteractionCreateEvent) -> str:
    """按钮回传的 data(没有则退回 button_id)。"""
    resolved = getattr(event.data, "resolved", None)
    if resolved is None:
        return ""
    return (getattr(resolved, "button_data", "") or "") or (
        getattr(resolved, "button_id", "") or ""
    )


def _button_index(event: InteractionCreateEvent) -> int | None:
    """解析壁纸编号按钮,不是该类按钮时返回 None。"""
    raw = _button_data(event)
    if not raw.startswith(BUTTON_DATA_PREFIX):
        return None
    try:
        return int(raw[len(BUTTON_DATA_PREFIX):])
    except ValueError:
        return None


def _button_page(event: InteractionCreateEvent) -> int | None:
    """解析上一页/下一页按钮,不是该类按钮时返回 None。"""
    raw = _button_data(event)
    if not raw.startswith(PAGE_BUTTON_PREFIX):
        return None
    try:
        return int(raw[len(PAGE_BUTTON_PREFIX):])
    except ValueError:
        return None


async def _ack(bot: Bot, event: InteractionCreateEvent, code: int = 0) -> None:
    """回执按钮交互,否则客户端上的按钮会一直转圈。"""
    try:
        await bot.put_interaction(interaction_id=event.id, code=code)  # type: ignore[arg-type]
    except Exception as err:  # noqa: BLE001
        logger.warning(f"[chat2] 按钮交互回执失败: {err}")


_wallpaper_button = on_type(
    InteractionCreateEvent,
    rule=lambda event: isinstance(event, InteractionCreateEvent)
    and (_button_index(event) is not None or _button_page(event) is not None),
    priority=1,
    block=True,
)


@_wallpaper.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    if not (Config.wallpaper or {}).get("enable", True):
        await matcher.finish("壁纸功能未启用")
    matched = re.match(_WALLPAPER_RE, event.get_plaintext().strip())
    page = int(matched.group(1)) if matched and matched.group(1) else 1
    try:
        page_data = await get_wallpaper_page(page)
        logger.info(f"[chat2] 壁纸预览: 第 {page_data['page']} 页,共 {page_data['totalPages']} 页")
        await send_wallpaper_preview(matcher, page_data)
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 壁纸列表获取失败: {err}")
        await matcher.finish(f"壁纸获取失败:{err}")


@_download.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    if not (Config.wallpaper or {}).get("enable", True):
        await matcher.finish("壁纸功能未启用")
    matched = re.match(_DOWNLOAD_RE, event.get_plaintext().strip())
    indexes = (
        [int(n) for n in re.split(r"[,，]+", matched.group(1))]
        if matched
        else []
    )
    if not indexes:
        await matcher.finish("用法:#下载1 或 #下载1,2(编号见 #壁纸 列表)")
    try:
        urls = await get_wallpaper_original_urls(indexes)
        for url in urls:
            buffer = await fetch_wallpaper_buffer(url)
            await send_image(matcher, buffer)
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 壁纸下载失败: {err}")
        await matcher.finish(f"壁纸下载失败:{err}")


@_wallpaper_button.handle()
async def _(bot: Bot, matcher: Matcher, event: InteractionCreateEvent) -> None:
    index = _button_index(event)
    page = None if index is not None else _button_page(event)
    if index is None and page is None:
        return
    # 先回执,避免用户侧按钮长时间加载
    await _ack(bot, event)
    if not (Config.wallpaper or {}).get("enable", True):
        await matcher.finish("壁纸功能未启用")
    try:
        if page is not None:
            logger.info(f"[chat2] 壁纸按钮翻页: 第 {page} 页")
            await send_wallpaper_preview(matcher, await get_wallpaper_page(page))
            return
        logger.info(f"[chat2] 壁纸按钮点击: 编号 {index}")
        for url in await get_wallpaper_original_urls([index]):
            await send_image(matcher, await fetch_wallpaper_buffer(url))
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 壁纸按钮处理失败: {err}")
        await matcher.finish(f"壁纸处理失败:{err}")
