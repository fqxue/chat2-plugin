"""壁纸服务,移植自 models/wallpaper.js。

调用腾讯云开发(CloudBase)函数 ``app`` 的 /wallpaper/wallpaper_days 接口,
请求带 HMAC-SHA256 签名,响应为 OpenSSL 加密的 AES-256-CBC
(Salted__ + EVP_BytesToKey 派生 32 字节密钥)。
"""

import asyncio
import base64
import hashlib
import hmac as hmac_mod
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7
from nonebot.log import logger

from .config import Config
from .media_send import USER_AGENT

CLOUD_CONFIG = {
    "endpoint": "https://env-00jxtf6hq8tr.api-hz.cloudbasefunction.cn",
    "functionName": "app",
    "spaceId": "env-00jxtf6hq8tr",
    "spaceAppId": "2021005135628147",
    "accessKey": "eYuqoprO4Ezad1pj",
    "secretKey": "mU0zgq1OsDi6ZoTA",
}

CLIENT_INFO = {
    "platform": "MP-WEIXIN",
    "appId": "wx633e9b3c05402e0d",
    "systemPlatform": "windows",
    "uniPlatform": "mp-weixin",
}

RESPONSE_AES_KEY = "yutuge1079422d21b1941625f8b0628f"

HTTP_TIMEOUT = 60.0

# 壁纸日期展示时区(接口按天返回,固定 UTC+8 与国内一致)
WALLPAPER_TZ = timezone(timedelta(hours=8))

# 壁纸图床(alioss.ibzhi.com 的 CDN)有 Referer 白名单,
# 空 referer/普通站点的 referer 都会被拒(denied by Referer ACL),仅允许微信小程序来源
WALLPAPER_REFERER = "https://servicewechat.com/"

# 最新壁纸列表缓存(接口按天返回,短时间内不会变化)
_latest_cache: list[dict[str, Any]] | None = None
_latest_cache_time: float = 0.0
CACHE_TTL = 10 * 60.0


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hmac_hex(value: str, key: str) -> str:
    return hmac_mod.new(key.encode("utf-8"), value.encode("utf-8"), hashlib.sha256).hexdigest()


def _evp_bytes_to_key(password: bytes, salt: bytes, key_len: int, iv_len: int) -> tuple[bytes, bytes]:
    """OpenSSL EVP_BytesToKey(MD5 迭代派生 key/iv),与 JS/Python 原版逐字节一致。"""
    data = b""
    prev = b""
    while len(data) < key_len + iv_len:
        prev = hashlib.md5(prev + password + salt).digest()
        data += prev
    return data[:key_len], data[key_len:key_len + iv_len]


def decrypt_openssl_aes(base64_cipher: str, password: str = RESPONSE_AES_KEY) -> str:
    """解密 OpenSSL 加密的响应(Salted__ 头 + AES-256-CBC + PKCS7),非加密内容原样返回。"""
    try:
        raw = base64.b64decode(base64_cipher)
    except Exception:
        return base64_cipher
    if len(raw) < 16 or raw[:8] != b"Salted__":
        return base64_cipher
    salt = raw[8:16]
    encrypted = raw[16:]
    key, iv = _evp_bytes_to_key(password.encode("utf-8"), salt, 32, 16)
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(encrypted) + decryptor.finalize()
    unpadder = PKCS7(128).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")


def _build_invoke_headers(body_json: str) -> dict[str, str]:
    timestamp = str(int(time.time() * 1000))
    trace_id = str(uuid.uuid4())
    headers = {
        "x-to-function-name": CLOUD_CONFIG["functionName"],
        "x-from-app-id": CLOUD_CONFIG["spaceAppId"],
        "x-from-env-id": CLOUD_CONFIG["spaceId"],
        "x-to-env-id": CLOUD_CONFIG["spaceId"],
        "x-from-instance-id": timestamp,
        "x-from-function-name": CLOUD_CONFIG["functionName"],
        "x-client-timestamp": timestamp,
        "x-alipay-source": "client",
        "x-request-id": trace_id,
        "x-alipay-callid": trace_id,
        "x-trace-id": trace_id,
        "content-type": "application/json",
    }
    signed_headers = [
        "x-from-app-id",
        "x-from-env-id",
        "x-to-env-id",
        "x-from-instance-id",
        "x-from-function-name",
        "x-client-timestamp",
        "x-to-function-name",
    ]
    canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in signed_headers)
    canonical_request = "\n".join(
        [
            "POST",
            "/functions/invokeFunction",
            "",
            canonical_headers,
            ";".join(signed_headers),
            _sha256_hex(body_json),
            "",
        ]
    )
    authorization_payload = "\n".join(
        ["HMAC-SHA256", timestamp, _sha256_hex(canonical_request), ""]
    )
    headers["Authorization"] = " ".join(
        [
            "HMAC-SHA256",
            f"Credential={CLOUD_CONFIG['accessKey']},",
            f"SignedHeaders={';'.join(signed_headers)},",
            f"Signature={_hmac_hex(authorization_payload, CLOUD_CONFIG['secretKey'])}",
        ]
    )
    return headers


async def _invoke_app(pathname: str, param: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(
        {"path": pathname, "param": param, "client": CLIENT_INFO, "headers": {"token": ""}},
        separators=(",", ":"),
    )
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        response = await client.post(
            f"{CLOUD_CONFIG['endpoint']}/functions/invokeFunction",
            headers=_build_invoke_headers(body),
            content=body,
        )
    text = response.text
    if not response.is_success:
        raise RuntimeError(f"壁纸接口 HTTP {response.status_code}: {text[:120]}")
    try:
        payload = json.loads(decrypt_openssl_aes(text))
    except Exception as err:
        raise RuntimeError(f"壁纸接口响应解析失败: {err}") from err
    if payload.get("code") != 200:
        raise RuntimeError(f"壁纸接口错误 {payload.get('code')}: {payload.get('msg') or '未知错误'}")
    return payload


def _format_day(day_ms: Any) -> str:
    # 壁纸按"天"更新,固定按 UTC+8 展示,避免服务器是 UTC 时日期差一天
    try:
        moment = datetime.fromtimestamp(float(day_ms) / 1000, tz=WALLPAPER_TZ)
    except (TypeError, ValueError, OSError, OverflowError):
        return "未知日期"
    return moment.strftime("%Y-%m-%d")


async def get_latest_wallpapers() -> list[dict[str, Any]]:
    """获取最新壁纸列表(带缓存),返回 [{index, code, dayStr, thumbUrl, originalUrl}]。"""
    global _latest_cache, _latest_cache_time
    wallpaper_cfg = Config.wallpaper or {}
    if not wallpaper_cfg.get("enable", True):
        raise RuntimeError("壁纸功能未启用")
    if _latest_cache and time.time() - _latest_cache_time < CACHE_TTL:
        return _latest_cache

    payload = await _invoke_app("/wallpaper/wallpaper_days", {"page": 1, "returnAll": True})
    items: list[dict[str, Any]] = []
    for group in payload.get("data") or []:
        day_str = _format_day(group.get("day"))
        for wp in group.get("wallpapers") or []:
            items.append(
                {
                    "index": len(items) + 1,
                    "code": str(wp.get("code") or f"item-{len(items) + 1}"),
                    "dayStr": day_str,
                    "thumbUrl": wp.get("imageUrl") or "",
                    "originalUrl": wp.get("imageUrlOriginal")
                    or wp.get("imageUrlDetail")
                    or wp.get("imageUrl")
                    or "",
                }
            )
    if not items:
        raise RuntimeError("壁纸接口没有返回任何数据,请稍后重试")
    _latest_cache = items
    _latest_cache_time = time.time()
    return items


async def get_wallpaper_page(page: int = 1) -> dict[str, Any]:
    """取某一页壁纸,返回 {page, totalPages, items}。"""
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise RuntimeError("页码必须是大于等于 1 的整数")
    configured = (Config.wallpaper or {}).get("pageSize", 9)
    page_size = configured if isinstance(configured, int) and 0 < configured <= 50 else 9
    all_items = await get_latest_wallpapers()
    total_pages = max(1, -(-len(all_items) // page_size))
    if page > total_pages:
        raise RuntimeError(f"页码超出范围,当前最大页数是 {total_pages}")
    return {
        "page": page,
        "totalPages": total_pages,
        "items": all_items[(page - 1) * page_size: page * page_size],
    }


async def get_wallpaper_original_urls(indexes: list[int]) -> list[str]:
    """按"全局编号"取原图 URL 列表(编号即预览图上显示的编号,1 = 最新一张,自动跨页)。"""
    if not indexes:
        raise RuntimeError("请提供至少一个壁纸编号")
    all_items = await get_latest_wallpapers()
    item_map = {item["index"]: item for item in all_items}
    urls: list[str] = []
    missing: list[str] = []
    for index in indexes:
        item = item_map.get(index)
        if item and item.get("originalUrl"):
            urls.append(item["originalUrl"])
        else:
            missing.append(str(index))
    if missing:
        raise RuntimeError(
            f"编号 {','.join(missing)} 不存在,当前最新共 {len(all_items)} 张壁纸,"
            f"编号范围 1 ~ {len(all_items)}"
        )
    return urls


async def fetch_wallpaper_buffer(url: str) -> bytes:
    """下载壁纸图片(自动带防盗链 Referer);网络抖动自动重试一次。"""
    last_err: Exception | None = None
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(
                timeout=120.0, follow_redirects=True,
                headers={
                    "User-Agent": USER_AGENT,
                    "Referer": WALLPAPER_REFERER,
                    "Accept": "image/*,*/*",
                },
            ) as client:
                response = await client.get(url)
            if not response.is_success:
                raise RuntimeError(f"HTTP {response.status_code}")
            if not response.content:
                raise RuntimeError("下载内容为空")
            return response.content
        except Exception as err:  # noqa: BLE001
            last_err = err
            if attempt == 1:
                logger.warning(f"[chat2] 壁纸图片下载失败({err}),1 秒后重试")
                await asyncio.sleep(1)
    raise RuntimeError(f"壁纸图片下载失败: {last_err}")
