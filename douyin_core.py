"""抖音分享链接解析,移植自 models/douyin.js。

识别分享链接 → 跟随重定向提取作品 ID → 详情接口 → 视频/图文。
"""

import json
import re
from typing import Any
from urllib.parse import quote

import httpx

from .signing import websign
from .signing.abogus import ABogus, browser_info_from_screen

SHARE_URL_RE = re.compile(
    r"https?://(?:v\.douyin\.com|www\.douyin\.com|www\.iesdouyin\.com)/[^\s\])]+", re.I
)
AWEME_PATH_RE = re.compile(r"/(?:video|note|share/video)/(\d+)(?:[/?#]|$)", re.I)
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "Chrome/126.0.0.0 Safari/537.36"
)
# 分享页与详情接口的请求超时(秒)
REQUEST_TIMEOUT = 30.0
DOUYIN_DETAIL_PARAMS = {
    "device_platform": "webapp",
    "aid": "6383",
    "channel": "channel_pc_web",
    "pc_client_type": "1",
    "version_code": "290100",
    "version_name": "29.1.0",
    "cookie_enabled": "true",
    "screen_width": "1920",
    "screen_height": "1080",
    "browser_language": "zh-CN",
    "browser_platform": "Win32",
    "browser_name": "Chrome",
    "browser_version": "126.0.0.0",
    "browser_online": "true",
    "engine_name": "Blink",
    "engine_version": "126.0.0.0",
    "os_name": "Windows",
    "os_version": "10",
    "cpu_core_num": "12",
    "device_memory": "8",
    "platform": "PC",
    "downlink": "10",
    "effective_type": "4g",
    "round_trip_time": "0",
    "update_version_code": "170400",
}


class DouyinParseError(RuntimeError):
    def __init__(self, message: str, code: str = "PARSE_ERROR") -> None:
        super().__init__(message)
        self.code = code


def extract_share_url(text: str) -> str:
    match = SHARE_URL_RE.search(str(text or ""))
    if not match:
        raise DouyinParseError("消息中未找到抖音分享链接", "INVALID_INPUT")
    return re.sub(r"[.,;!?，。；！？]+$", "", match.group(0))


def extract_aweme_id(url: str) -> str:
    match = AWEME_PATH_RE.search(str(url or ""))
    if not match:
        raise DouyinParseError("无法从抖音链接提取作品 ID", "INVALID_URL")
    return match.group(1)


def _cookie_jar(cookie: str) -> dict[str, str]:
    return {
        key.strip(): value.strip()
        for part in cookie.split(";")
        if "=" in part
        for key, value in [part.split("=", 1)]
        if key.strip()
    }


def _signed_detail_url(aweme_id: str, cookie: str) -> tuple[str, dict[str, str]]:
    cookies = _cookie_jar(cookie)
    params = dict(DOUYIN_DETAIL_PARAMS)
    params["aweme_id"] = aweme_id
    if cookies.get("msToken"):
        params["msToken"] = cookies["msToken"]
    query = "&".join(quote(key, safe="") + "=" + quote(value, safe="") for key, value in params.items())
    bogus = ABogus(UA, browser_info=browser_info_from_screen(1920, 1080, "Win32")).get_value(query)
    pairs = list(params.items()) + [("a_bogus", bogus)]
    verify_fp = cookies.get(websign.VERIFY_FP_COOKIE)
    if verify_fp:
        pairs.extend((name, verify_fp) for name in websign.VERIFY_FP_PARAMS)
    uifid = websign.pick_uifid(cookies)
    if not uifid:
        return query + "&a_bogus=" + quote(bogus, safe=""), {}
    signed_query, _, headers = websign.sign(pairs, uifid)
    return signed_query, headers


def _first(obj: Any, *keys: str) -> Any:
    if not isinstance(obj, dict):
        return None
    for key in keys:
        if key in obj:
            return obj[key]
    return None


def _urls(value: Any) -> list[str]:
    url_list = _first(value, "url_list", "urlList")
    if isinstance(url_list, list):
        return [u for u in url_list if isinstance(u, str) and re.match(r"^https?://", u, re.I)]
    return []


def _preferred_urls(urls: list[str]) -> list[str]:
    """Prefer the second CDN mirror, which is more reliable for QQ downloads."""
    return urls[1:] + urls[:1] if len(urls) > 1 else urls


def _video_candidate(addr: dict[str, Any], meta: dict[str, Any] | None = None) -> dict[str, Any] | None:
    urls = _urls(addr)
    if not urls:
        return None
    urls = _preferred_urls(urls)
    return {
        "url": urls[0],
        "alternativeUrls": urls[1:],
        "width": _first(addr, "width") or _first(meta or {}, "width"),
        "height": _first(addr, "height") or _first(meta or {}, "height"),
        "bitrate": _first(meta or {}, "bit_rate") or 0,
        "size": _first(addr, "data_size") or 0,
        "isH265": bool(_first(meta or {}, "is_h265") or _first(meta or {}, "is_bytevc1")),
    }


def _video_candidates(video: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for meta in video.get("bit_rate") or []:
        if isinstance(meta, dict):
            candidate = _video_candidate(meta.get("play_addr") or {}, meta)
            if candidate:
                candidates.append(candidate)
    for key in ("play_addr_265", "play_addr", "play_addr_h264"):
        addr = video.get(key)
        if isinstance(addr, dict):
            candidate = _video_candidate(addr)
            if candidate:
                candidates.append(candidate)
    candidates.sort(
        key=lambda item: (
            int(item.get("width") or 0) * int(item.get("height") or 0),
            int(item.get("height") or 0),
            int(item.get("width") or 0),
            int(item.get("bitrate") or 0),
            int(item.get("size") or 0),
        ),
        reverse=True,
    )
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in candidates:
        if item["url"] not in seen:
            seen.add(item["url"])
            unique.append(item)
    return unique


def _normalize(detail: dict[str, Any]) -> dict[str, Any]:
    aweme_id = str(_first(detail, "aweme_id", "awemeId") or "")
    if not aweme_id:
        raise DouyinParseError("抖音响应缺少作品 ID", "INVALID_RESPONSE")
    raw_images = detail.get("images") if isinstance(detail.get("images"), list) else []
    images: list[list[str]] = []
    for image in raw_images:
        # url_list 是无水印原图;download_url_list 的链接带 water 水印,
        # 因此放在后面,并且下面优先剔除带水印的候选
        urls = [
            url for url in (image.get("url_list") or []) + (image.get("download_url_list") or [])
            if isinstance(url, str) and re.match(r"^https?://", url, re.I)
        ]
        clean = [url for url in urls if "water" not in url.lower()]
        # 全部候选都带水印时才退回原列表,至少保证有图可发
        urls = _preferred_urls(clean or urls)
        if urls:
            images.append(urls)
    video_candidates: list[dict[str, Any]] = []
    if not images and isinstance(detail.get("video"), dict):
        video_candidates = _video_candidates(detail["video"])
    video = video_candidates[0] if video_candidates else None
    note_type = "note" if images else "video"
    return {
        "awemeId": aweme_id,
        "type": note_type,
        "canonicalUrl": f"https://www.douyin.com/{'note' if images else 'video'}/{aweme_id}",
        "description": _first(detail, "desc") or "",
        "videoUrl": video["url"] if video else None,
        "videoAlternativeUrls": video["alternativeUrls"] if video else [],
        "videoWidth": video["width"] if video else None,
        "videoHeight": video["height"] if video else None,
        "videoBitrate": video["bitrate"] if video else None,
        "videoIsH265": video["isH265"] if video else False,
        # 时长(毫秒),配合 bit_rate 可在下载前估算体积:bitrate * duration / 8
        "durationMs": int(_first(detail, "duration") or 0)
        or int(_first(detail.get("video") or {}, "duration") or 0),
        "videoCandidates": video_candidates,
        "imageUrls": [urls[0] for urls in images],
        "imageCandidates": images,
    }


def parse_detail_json(payload: Any) -> dict[str, Any]:
    value = payload if isinstance(payload, dict) else json.loads(payload)
    detail = value.get("aweme_detail") or value.get("awemeDetail")
    if not detail:
        raise DouyinParseError("详情接口未返回 aweme_detail", "INVALID_RESPONSE")
    return _normalize(detail)


async def parse_share(input_text: str, cookie: str = "") -> dict[str, Any]:
    share_url = extract_share_url(input_text)
    cookie = re.sub(r"^\s*cookie\s*:\s*", "", str(cookie or ""), flags=re.I).strip()

    async with httpx.AsyncClient(
        timeout=REQUEST_TIMEOUT, follow_redirects=True,
        headers={"user-agent": UA, "accept": "text/html,application/xhtml+xml"},
    ) as client:
        if cookie:
            client.headers["cookie"] = cookie
        response = await client.get(share_url)
        redirect_url = str(response.url)
        if not response.is_success:
            raise DouyinParseError(f"抖音页面 HTTP {response.status_code}", "HTTP_ERROR")
        aweme_id = extract_aweme_id(redirect_url)

        detail_query, signing_headers = _signed_detail_url(aweme_id, cookie)
        detail_url = "https://www.douyin.com/aweme/v1/web/aweme/detail/?" + detail_query
        detail_response = await client.get(
            detail_url,
            headers={
                "user-agent": UA,
                "accept": "application/json,text/plain,*/*",
                "referer": redirect_url,
                **signing_headers,
            },
        )
        detail_text = detail_response.text
        if not detail_response.is_success or not detail_text.strip():
            raise DouyinParseError(
                "抖音详情接口未返回数据,请更新 Cookie 或稍后重试", "DETAIL_EMPTY"
            )
    result = parse_detail_json(detail_text)
    result["shareUrl"] = share_url
    result["redirectUrl"] = redirect_url
    return result
