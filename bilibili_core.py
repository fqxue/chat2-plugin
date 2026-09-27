"""Bilibili link extraction and media download via yt-dlp."""

from __future__ import annotations

import asyncio
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import imageio_ffmpeg
from yt_dlp import YoutubeDL

from .media_send import download_limited


BILIBILI_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?bilibili\.com/video/[A-Za-z0-9]+[^\s\])]*"
    r"|https?://b23\.tv/[A-Za-z0-9]+[^\s\])]*",
    re.IGNORECASE,
)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/126.0.0.0 Safari/537.36"
)


class BilibiliParseError(RuntimeError):
    """An input or upstream Bilibili response could not be parsed."""


def extract_bilibili_url(text: str) -> str:
    match = BILIBILI_URL_RE.search(str(text or ""))
    if not match:
        raise BilibiliParseError("消息中未找到 Bilibili 视频链接")
    return re.sub(r"[.,;!?，。；！？]+$", "", match.group(0))


def _extract_info(url: str) -> dict[str, Any]:
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "http_headers": {"User-Agent": _UA, "Referer": "https://www.bilibili.com/"},
    }
    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if not isinstance(info, dict):
        raise BilibiliParseError("Bilibili 未返回视频信息")
    entries = info.get("entries")
    if entries:
        first = next((entry for entry in entries if isinstance(entry, dict)), None)
        if first:
            info = first
    return info


def _format_size(item: dict[str, Any]) -> int:
    """yt-dlp 给出的体积(filesize / filesize_approx),未知返回 0。"""
    for key in ("filesize", "filesize_approx"):
        try:
            value = int(item.get(key) or 0)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return 0


def _best_audio_size(info: dict[str, Any]) -> int:
    """最佳音轨的体积(字节),B站合并下载是 视频流 + 音轨。"""
    audio = [
        item
        for item in info.get("formats", [])
        if isinstance(item, dict)
        and item.get("acodec") not in (None, "none")
        and item.get("vcodec") in (None, "none")
    ]
    sizes = [size for size in (_format_size(item) for item in audio) if size > 0]
    return max(sizes) if sizes else 0


def _pick_video_format(
    info: dict[str, Any], max_bytes: int | None = None
) -> dict[str, Any]:
    formats = [item for item in info.get("formats", []) if isinstance(item, dict)]
    usable = [
        item for item in formats
        if item.get("url") and item.get("vcodec") not in (None, "none")
    ]
    if not usable:
        raise BilibiliParseError("Bilibili 未找到可下载的视频流")
    if max_bytes:
        # 已知体积且未超限的档位优先,避免下载完再发现超限
        sized = [item for item in usable if 0 < _format_size(item) <= max_bytes]
        if sized:
            usable = sized
    # Prefer the highest resolution and bitrate. Bilibili commonly exposes DASH
    # video/audio separately; a video-only MP4 remains playable in QQ.
    usable.sort(
        key=lambda item: (
            item.get("height") or 0,
            item.get("width") or 0,
            item.get("tbr") or 0,
            item.get("ext") == "mp4",
        ),
        reverse=True,
    )
    return usable[0]


async def parse_bilibili(input_text: str, max_bytes: int | None = None) -> dict[str, Any]:
    url = extract_bilibili_url(input_text)
    try:
        info = await asyncio.to_thread(_extract_info, url)
    except BilibiliParseError:
        raise
    except Exception as err:  # noqa: BLE001
        raise BilibiliParseError(f"Bilibili 解析失败:{err}") from err
    # 合并下载得到的是 视频流 + 音轨,选流时先从预算里扣掉音轨体积
    audio_size = _best_audio_size(info) if max_bytes else 0
    budget = max(max_bytes - audio_size, 1) if max_bytes else None
    media = _pick_video_format(info, budget)
    return {
        "id": str(info.get("id") or ""),
        "title": str(info.get("title") or "Bilibili 视频"),
        "source_url": url,
        "url": str(media["url"]),
        "ext": str(media.get("ext") or "mp4"),
        "videoSize": _format_size(media) or None,
        "audioSize": audio_size or None,
        "headers": media.get("http_headers") or {"User-Agent": _UA},
    }


def estimate_media_size(media: dict[str, Any]) -> int:
    """下载前预估成品体积:选中视频流 + 最佳音轨。"""
    return int(media.get("videoSize") or 0) + int(media.get("audioSize") or 0)


async def download_bilibili(media: dict[str, Any], max_bytes: int | None = None) -> bytes:
    """Download and merge Bilibili DASH streams when ffmpeg is available."""
    ffmpeg = shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()
    if media.get("source_url") and ffmpeg:
        try:
            return await asyncio.to_thread(_download_merged, str(media["source_url"]), ffmpeg)
        except Exception:
            # A direct video stream is still useful when a merge or codec fails.
            pass
    headers = {"User-Agent": _UA, "Referer": "https://www.bilibili.com/"}
    headers.update({str(k): str(v) for k, v in (media.get("headers") or {}).items()})
    # 流式下载:途中超过上限立即中断,不再继续占用带宽
    return await download_limited(
        [str(media["url"])], limit=max_bytes, headers=headers, timeout=180.0
    )


def _download_merged(url: str, ffmpeg: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="chat2-bilibili-") as directory:
        options = {
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "noplaylist": True,
            "format": "bestvideo*+bestaudio/best",
            "merge_output_format": "mp4",
            "ffmpeg_location": ffmpeg,
            "outtmpl": f"{directory}/%(id)s.%(ext)s",
            "http_headers": {"User-Agent": _UA, "Referer": "https://www.bilibili.com/"},
        }
        with YoutubeDL(options) as ydl:
            ydl.download([url])
        files = [item for item in Path(directory).iterdir() if item.is_file()]
        if not files:
            raise BilibiliParseError("Bilibili 合并下载未生成文件")
        return max(files, key=lambda item: item.stat().st_size).read_bytes()
