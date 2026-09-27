"""图片生成/编辑的共享核心,移植自 models/image.js。

- 直接指令调用(matcher_image.py)
- 作为 agent 工具供对话模型调用(chat_tool.py)
复用同一个函数,保证两种入口行为一致。
"""

import base64
import re
from typing import Any

import httpx
from nonebot.adapters.qq import QQMessageEvent
from nonebot.log import logger
from openai import APIStatusError

from .config import Config
from .llm import get_image_client, normalize_timeout
from .media_send import USER_AGENT


def collect_event_images(event: QQMessageEvent) -> list[str]:
    """从事件中收集真实存在的图片引用(当前消息附带 or 引用消息中的图片)。"""
    urls: list[str] = []
    try:
        for segment in event.get_message():
            if segment.type == "image" and isinstance(segment.data.get("url"), str):
                urls.append(segment.data["url"])
    except Exception as err:  # noqa: BLE001
        logger.warning(f"[chat2] 提取消息图片失败: {err}")
    reply = getattr(event, "reply", None)
    if reply is not None:
        for attachment in getattr(reply, "attachments", None) or []:
            url = getattr(attachment, "url", None)
            content_type = (getattr(attachment, "content_type", "") or "").split("/", 1)[0]
            if isinstance(url, str) and content_type in {"image", "file"}:
                urls.append(url)
    return [url for url in urls if re.match(r"^(https?|file|data):", url, re.I)]


async def fetch_image_data_url(url: str) -> str | None:
    """预下载参考图为 data URL;失败返回 None(回退为直接传 URL)。"""
    try:
        async with httpx.AsyncClient(
            timeout=30.0, follow_redirects=True,
            headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*"},
        ) as client:
            response = await client.get(url)
        if not response.is_success:
            raise RuntimeError(f"HTTP {response.status_code}")
        content_type = (response.headers.get("content-type") or "image/png").split(";")[0]
        if not content_type.startswith("image/"):
            raise RuntimeError(f"响应不是图片:{content_type}")
        data = base64.b64encode(response.content).decode()
        return f"data:{content_type};base64,{data}"
    except Exception as err:  # noqa: BLE001
        logger.warning(f"[chat2] 预下载参考图失败,回退为直接传 URL: {err}")
        return None


def detect_image_ext(buf: bytes) -> str:
    """按魔数识别图片扩展名。"""
    if len(buf) > 2 and buf[0] == 0x89 and buf[1] == 0x50:
        return "png"
    if len(buf) > 2 and buf[0] == 0xFF and buf[1] == 0xD8:
        return "jpg"
    if len(buf) > 12 and buf[8:12] == b"WEBP":
        return "webp"
    if len(buf) > 3 and buf[0] == 0x47 and buf[1] == 0x49:
        return "gif"
    return "jpg"


def _media_type(buf: bytes) -> str:
    ext = detect_image_ext(buf)
    return "image/jpeg" if ext == "jpg" else f"image/{ext}"


def _data_url_bytes(value: str) -> bytes | None:
    """从 data URL 解出原始字节;不是 data URL、内容损坏或解出为空时返回 None。"""
    if not value.startswith("data:"):
        return None
    try:
        raw = base64.b64decode(value.split(",", 1)[1])
    except (ValueError, IndexError):
        return None
    return raw or None


async def resolve_images(images: list[str] | tuple[str, ...]) -> list[str]:
    """将调用方传入的图片引用归一化为模型可接受的 data URL。"""
    resolved: list[str] = []
    for image in images:
        text = str(image)
        if re.match(r"^data:", text, re.I):
            resolved.append(text)
        elif re.match(r"^https?:", text, re.I):
            # 平台图片 URL(QQ 等)常带防盗链或 UA 校验,先由插件侧预下载
            resolved.append(await fetch_image_data_url(text) or text)
        elif re.match(r"^file:", text, re.I):
            # file:// 读本地文件转 data URL
            try:
                from pathlib import Path
                from urllib.parse import unquote, urlparse

                local_path = Path(unquote(urlparse(text).path))
                buffer = local_path.read_bytes()
                resolved.append(f"data:{_media_type(buffer)};base64,{base64.b64encode(buffer).decode()}")
            except Exception as err:  # noqa: BLE001
                logger.warning(f"[chat2] 本地参考图读取失败: {err}")
        else:
            # 裸 base64 包装为 data URL,按魔数识别真实类型
            try:
                buffer = base64.b64decode(text)
                resolved.append(f"data:{_media_type(buffer)};base64,{text}")
            except Exception as err:  # noqa: BLE001
                logger.warning(f"[chat2] 参考图 base64 解析失败: {err}")
    return resolved


_MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((https?://[^)\s]+)\)")
_MD_LINK_RE = re.compile(r"\[[^\]]*\]\((https?://[^)\s]+)\)")
_BARE_IMAGE_RE = re.compile(r"https?://[^\s)\"']+\.(?:png|jpe?g|webp|gif)", re.I)


def extract_image_url_from_markdown(text: str) -> str | None:
    """从模型返回的 Markdown 文本中提取图片 URL(兼容非标准返回格式的图片站点)。"""
    if not text or not isinstance(text, str):
        return None
    for pattern in (_MD_IMAGE_RE, _MD_LINK_RE, _BARE_IMAGE_RE):
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


async def _download_image_base64(url: str) -> str:
    """带浏览器 UA 下载图片,返回 base64。"""
    logger.info(f"[chat2] 开始下载生成结果:{url}")
    async with httpx.AsyncClient(
        timeout=120.0, follow_redirects=True,
        headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*"},
    ) as client:
        response = await client.get(url)
    if not response.is_success:
        raise RuntimeError(f"下载生成结果失败:HTTP {response.status_code}")
    content_type = (response.headers.get("content-type") or "image/png").split(";")[0]
    if not content_type.startswith("image/"):
        raise RuntimeError(f"生成结果不是图片(Content-Type: {content_type}),URL: {url}")
    logger.info(f"[chat2] 生成结果下载完成:{content_type},{round(len(response.content) / 1024)} KB")
    return base64.b64encode(response.content).decode()


async def generate_image_base64(prompt: str, images: list[str] | None = None) -> str:
    """生成或编辑图片,返回图片 base64。

    :param prompt: 图片描述 / 编辑指令
    :param images: 参考图片(URL 或 base64),提供时走编辑流程
    """
    image_cfg = Config.image or {}
    if not image_cfg.get("model"):
        raise RuntimeError("未启用图片功能,请联系主人配置 image.model")

    client = get_image_client()
    timeout = normalize_timeout(image_cfg.get("timeout"), 180000)
    size = image_cfg.get("size") or None
    images = images or []
    # 未配置尺寸时不能传 size=None:SDK 会把它序列化成 "size": null,
    # 多数接口(含中转站)会直接报 400,这里改为整个字段缺省
    size_kwargs: dict[str, Any] = {"size": size} if size else {}

    try:
        if images:
            # 编辑模式:图片输入 + 文字指令(images.edit 需要 multipart,httpx 三元组即可)
            # 参考图必须落到 data URL 才能拿到二进制;拿不到就直接报错,
            # 不能把 URL 当 base64 解(会静默产出垃圾字节发给接口)
            resolved = await resolve_images(images)
            buffer = _data_url_bytes(resolved[0]) if resolved else None
            if buffer is None:
                raise RuntimeError("参考图无法读取(下载失败或格式不支持),请重新发送图片")
            response = await client.images.edit(
                model=image_cfg["model"],
                image=("image.png", buffer, _media_type(buffer)),
                prompt=prompt or "请编辑这张图片",
                timeout=timeout,
                **size_kwargs,  # type: ignore[arg-type]
            )
        else:
            if not prompt:
                raise RuntimeError("缺少图片描述(prompt)")
            response = await client.images.generate(
                model=image_cfg["model"],
                prompt=prompt,
                timeout=timeout,
                **size_kwargs,  # type: ignore[arg-type]
            )
    except APIStatusError as err:
        # 兼容非标准返回:部分图片站点的接口返回 Markdown 文本而非 JSON
        body = getattr(err.response, "text", "") or ""
        url = extract_image_url_from_markdown(body)
        if url:
            logger.info(f"[chat2] 图片接口返回 Markdown 格式,提取图片 URL 自行下载:{url}")
            return await _download_image_base64(url)
        raise

    if not response.data:
        raise RuntimeError("图片模型没有返回图片数据")
    item = response.data[0]
    if getattr(item, "b64_json", None):
        return item.b64_json
    if getattr(item, "url", None):
        return await _download_image_base64(item.url)
    raise RuntimeError("图片模型没有返回图片数据")
