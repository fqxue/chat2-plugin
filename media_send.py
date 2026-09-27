"""共享的 QQ 消息发送与媒体下载工具:统一 UA、体积上限、失败重试。"""

import asyncio
import io
import re
from typing import Any

import httpx
from nonebot.adapters.qq import MessageSegment
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .config import Config

# 全插件统一的外网请求 UA(图片生成结果、壁纸 CDN、抖音 CDN 都按浏览器 UA 放行)
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class VideoTooLarge(RuntimeError):
    """视频体积超过配置上限。"""

    def __init__(self, size_mb: float, limit_mb: float) -> None:
        super().__init__(
            f"视频约 {size_mb} MB,超过上限 {limit_mb} MB,"
            "可在 config.yaml 里调大 maxVideoSizeMb(填 0 表示不限制)"
        )
        self.size_mb = size_mb
        self.limit_mb = limit_mb


def max_video_bytes() -> int | None:
    """视频体积上限(字节);未配置或填 0 时返回 None 表示不限制。"""
    try:
        mb = float(getattr(Config, "maxVideoSizeMb", 0))
    except (TypeError, ValueError):
        return None
    return int(mb * 1024 * 1024) if mb > 0 else None


async def probe_remote_size(
    url: str, headers: dict[str, Any] | None = None, timeout: float = 15.0
) -> int | None:
    """下载前探测远端体积(字节):先 HEAD 取 Content-Length,
    不支持 HEAD 时退化为 Range: bytes=0-0 从 Content-Range 解析总大小。探测不到返回 None。
    """
    try:
        async with httpx.AsyncClient(
            timeout=timeout, follow_redirects=True, headers=headers
        ) as client:
            response = await client.head(url)
            if response.is_success:
                length = response.headers.get("content-length")
                if length and length.isdigit():
                    return int(length)
            ranged = await client.get(url, headers={"Range": "bytes=0-0"})
            content_range = (ranged.headers.get("content-range") or "").strip()
            matched = re.search(r"/(\d+)$", content_range)
            if matched:
                return int(matched.group(1))
            length = ranged.headers.get("content-length")
            if length and length.isdigit():
                return int(length)
    except Exception as err:  # noqa: BLE001
        logger.debug(f"[chat2] 体积探测失败({url[:60]}…): {err}")
    return None


async def download_limited(
    urls: list[str],
    limit: int | None = None,
    headers: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> bytes:
    """按顺序尝试候选地址流式下载。

    下载过程中一旦累计体积超过 limit 立刻中断并抛 VideoTooLarge(已下载的内容直接丢弃),
    避免"下完才发现超限"白白占用带宽和时间。
    """
    last_error: Exception | None = None
    for url in urls:
        try:
            buffer = bytearray()
            async with httpx.AsyncClient(
                timeout=timeout, follow_redirects=True, headers=headers
            ) as client:
                async with client.stream("GET", url) as response:
                    if not response.is_success:
                        raise RuntimeError(f"HTTP {response.status_code}")
                    async for chunk in response.aiter_bytes():
                        buffer.extend(chunk)
                        if limit is not None and len(buffer) > limit:
                            logger.info(
                                f"[chat2] 下载已超过 {round(limit / 1024 / 1024, 1)} MB,中断下载"
                            )
                            raise VideoTooLarge(
                                round(len(buffer) / 1024 / 1024, 1),
                                round(limit / 1024 / 1024, 1),
                            )
            if not buffer:
                raise RuntimeError("下载内容为空")
            return bytes(buffer)
        except VideoTooLarge:
            raise
        except Exception as err:  # noqa: BLE001
            last_error = err
    raise RuntimeError(f"全部媒体地址下载失败: {last_error}")


async def send_image(matcher: Matcher, data: bytes, file_name: str = "wallpaper.jpg") -> None:
    try:
        await matcher.send(MessageSegment.file_image(data, file_name=file_name))
    except Exception as err:
        logger.warning(f"[chat2] 图片发送失败,2 秒后重试: {err}")
        await asyncio.sleep(2)
        await matcher.send(MessageSegment.file_image(data, file_name=file_name))


async def send_video(matcher: Matcher, data: bytes, file_name: str = "video.mp4") -> None:
    """发送视频,超过配置上限时抛 VideoTooLarge。"""
    limit = max_video_bytes()
    if limit is not None and len(data) > limit:
        raise VideoTooLarge(round(len(data) / 1024 / 1024, 1), round(limit / 1024 / 1024, 1))
    logger.info(f"[chat2] 发送视频: {file_name},约 {round(len(data) / 1024 / 1024, 1)} MB")
    try:
        await matcher.send(MessageSegment.file_video(io.BytesIO(data), file_name=file_name))
    except Exception as err:
        logger.warning(f"[chat2] 视频发送失败,2 秒后重试: {err}")
        await asyncio.sleep(2)
        await matcher.send(MessageSegment.file_video(io.BytesIO(data), file_name=file_name))
