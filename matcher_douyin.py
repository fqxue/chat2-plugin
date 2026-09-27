"""抖音分享链接解析,移植自 apps/douyin.js。

视频下载后以富媒体发送;图文无合并转发,逐张发图(最多 9 张)。
"""

from nonebot import on_regex
from nonebot.adapters.qq import QQMessageEvent
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .config import Config
from .douyin_core import SHARE_URL_RE, parse_share
from .media_send import (
    USER_AGENT,
    VideoTooLarge,
    download_limited,
    max_video_bytes,
    probe_remote_size,
    send_image,
    send_video,
)

_douyin = on_regex(SHARE_URL_RE.pattern, priority=4, block=True)

# 图文下载用的请求头(复用统一 UA)
_MEDIA_HEADERS = {"User-Agent": USER_AGENT, "Accept": "*/*"}


def _candidate_size(candidate: dict, duration_ms: int) -> int:
    """下载前估算单个清晰度的体积(字节)。

    优先用接口给的 play_addr.data_size;缺失时用 bit_rate × 时长 / 8 估算。
    仍算不出返回 0(调用方会改用 HEAD 探测或跳过)。
    """
    size = int(candidate.get("size") or 0)
    if size > 0:
        return size
    bitrate = int(candidate.get("bitrate") or 0)
    if bitrate > 0 and duration_ms > 0:
        return int(bitrate * duration_ms / 1000 / 8)
    return 0


async def candidate_size(candidate: dict, duration_ms: int) -> int:
    """下载前确定档位体积(字节):接口数据 → 估算 → HEAD 探测,失败返回 0。"""
    size = _candidate_size(candidate, duration_ms)
    if size:
        return size
    return await probe_remote_size(candidate["url"], headers={"User-Agent": USER_AGENT}) or 0


def is_downloadable(size: int, limit: int | None) -> bool:
    """是否允许下载该档位:未设上限,或体积已确定且未超限。"""
    if limit is None:
        return True
    return 0 < size <= limit


@_douyin.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    # matcher.finish() 通过抛 FinishedException 结束,不能放在 try 里,
    # 否则会被下面的 except 当成解析失败再发一条错误提示
    try:
        result = await parse_share(
            event.get_plaintext(),
            cookie=(Config.douyin or {}).get("cookie", ""),
        )
    except Exception as err:  # noqa: BLE001
        logger.error(f"[chat2] 抖音解析失败: {err}")
        await matcher.finish(f"抖音解析失败:{err}")

    logger.info(
        f"[chat2] 抖音解析成功: type={result['type']}, awemeId={result['awemeId']}, "
        f"size={result.get('videoWidth')}x{result.get('videoHeight')}, "
        f"h265={result.get('videoIsH265', False)}"
    )
    if result["type"] == "video" and result.get("videoUrl"):
        limit = max_video_bytes()
        duration_ms = int(result.get("durationMs") or 0)
        buffer = None
        oversized = 0
        unknown = 0
        for candidate in result.get("videoCandidates") or []:
            size = 0
            if limit is not None:
                # 下载前判定体积:接口 data_size → bitrate×时长估算 → HEAD 探测
                size = await candidate_size(candidate, duration_ms)
                if not is_downloadable(size, limit):
                    if size > limit:
                        oversized += 1
                        logger.info(
                            f"[chat2] 抖音视频档位约 {round(size / 1024 / 1024, 1)} MB "
                            "超过上限,跳过该清晰度"
                        )
                    else:
                        # 体积无法在下载前确定时不冒险下载(长视频会拖死整个进程)
                        unknown += 1
                    continue
                logger.info(
                    f"[chat2] 抖音视频档位约 {round(size / 1024 / 1024, 1)} MB,可下载"
                )
            try:
                # 体积已在下载前判定;limit 仅作为兜底,防止个别接口体积不准
                buffer = await download_limited(
                    [candidate["url"], *candidate["alternativeUrls"]],
                    limit=limit,
                    headers=_MEDIA_HEADERS,
                )
                logger.info(
                    f"[chat2] 抖音视频已下载: {candidate['width']}x{candidate['height']}, "
                    f"bitrate={candidate['bitrate']}"
                )
                break
            except VideoTooLarge:
                buffer = None
                oversized += 1
                continue
            except Exception as err:  # noqa: BLE001
                logger.warning(f"[chat2] 抖音视频档位不可用,尝试下一档: {err}")
        if buffer is None:
            if oversized:
                await matcher.finish(
                    f"所有清晰度都超过 {round(limit / 1024 / 1024, 1)} MB 上限,"
                    "可在 config.yaml 调大 maxVideoSizeMb(填 0 表示不限制)"
                )
            if unknown:
                await matcher.finish(
                    "无法在下载前确定视频体积,已跳过下载;"
                    "如确实需要可把 maxVideoSizeMb 设为 0(不限制)"
                )
            await matcher.finish("所有视频清晰度均无法下载")
        try:
            await send_video(matcher, buffer, f"douyin-{result['awemeId']}.mp4")
        except VideoTooLarge as err:
            await matcher.finish(str(err))
        return

    if result["type"] == "note" and result.get("imageUrls"):
        image_candidates = result["imageCandidates"][:9]
        await matcher.send(f"共 {len(image_candidates)} 张图:")
        sent = 0
        for urls in image_candidates:
            try:
                buffer = await download_limited(urls, headers=_MEDIA_HEADERS, timeout=60.0)
            except Exception as err:  # noqa: BLE001
                logger.warning(f"[chat2] 抖音图片下载失败,跳过: {err}")
                continue
            await send_image(matcher, buffer, f"douyin-{result['awemeId']}-{sent + 1}.jpg")
            sent += 1
        if not sent:
            await matcher.finish("抖音图片下载失败")
        return

    await matcher.finish("未找到可发送的视频或图片")
