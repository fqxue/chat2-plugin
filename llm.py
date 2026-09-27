"""OpenAI 客户端工厂,移植自 models/provider.js。

按 baseURL|apiKey 缓存 AsyncOpenAI 客户端;支持任意 OpenAI 兼容接口。
"""

from openai import AsyncOpenAI

from .config import Config

_clients: dict[str, AsyncOpenAI] = {}


def _get_client(base_url: str, api_key: str, name: str) -> AsyncOpenAI:
    if not base_url or not api_key:
        raise RuntimeError("尚未配置 apiKey 或 baseURL,请编辑 plugins/chat2/config/config.yaml")
    key = f"{name}|{base_url}|{api_key}"
    client = _clients.get(key)
    if client is None:
        client = AsyncOpenAI(base_url=base_url, api_key=api_key)
        _clients[key] = client
    return client


def get_chat_client() -> AsyncOpenAI:
    return _get_client(Config.baseURL, Config.apiKey, "chat2")


def get_image_client() -> AsyncOpenAI:
    image = Config.image or {}
    base_url = image.get("baseURL") or Config.baseURL
    api_key = image.get("apiKey") or Config.apiKey
    return _get_client(base_url, api_key, "chat2-image")


def normalize_timeout(value: object, fallback: int, max_ms: int = 30 * 60 * 1000) -> float:
    """毫秒超时配置归一化为秒(float),供 AsyncOpenAI timeout 参数使用。"""
    try:
        ms = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback / 1000
    if ms <= 0:
        return fallback / 1000
    return min(int(ms), max_ms) / 1000
