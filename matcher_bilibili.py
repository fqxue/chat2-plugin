"""Bilibili video link matcher."""

from nonebot import on_regex
from nonebot.adapters.qq import QQMessageEvent
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .bilibili_core import (
    BILIBILI_URL_RE,
    download_bilibili,
    estimate_media_size,
    parse_bilibili,
)
from .media_send import VideoTooLarge, max_video_bytes, send_video


_bilibili = on_regex(BILIBILI_URL_RE.pattern, priority=4, block=True)


@_bilibili.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    # matcher.finish() 通过抛 FinishedException 结束,不能放在 try 里,
    # 否则会被下面的 except 当成解析失败再发一条错误提示
    limit = max_video_bytes()
    try:
        media = await parse_bilibili(event.get_plaintext(), max_bytes=limit)
        estimated = estimate_media_size(media)
        logger.info(
            f"[chat2] Bilibili 解析成功: {media['id']} {media['title']}"
            + (f",预估 {round(estimated / 1024 / 1024, 1)} MB" if estimated else "")
        )
        # 下载前最后一道判断:预估体积超限就直接提示,不再浪费下载与上传
        if limit is not None and estimated and estimated > limit:
            raise VideoTooLarge(round(estimated / 1024 / 1024, 1), round(limit / 1024 / 1024, 1))
        await matcher.send(f"正在下载 Bilibili 视频: {media['title']}")
        buffer = await download_bilibili(media, max_bytes=limit)
    except VideoTooLarge as err:
        await matcher.finish(str(err))
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] Bilibili 解析失败: {err}")
        await matcher.finish(f"Bilibili 解析失败:{err}")

    try:
        await send_video(matcher, buffer, f"bilibili-{media['id'] or 'video'}.{media['ext']}")
    except VideoTooLarge as err:
        await matcher.finish(str(err))
