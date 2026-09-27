"""极简的内存会话历史,移植自 models/history.js。

key 为会话标识:群聊 ``group:{group_openid}``,私聊 ``user:{user_openid}``。
历史超过 maxHistory 条时丢弃最旧的消息。
"""

from typing import Any

from nonebot.adapters.qq import QQMessageEvent

from .config import Config

_conversations: dict[str, list[dict[str, Any]]] = {}


def history_key(event: QQMessageEvent) -> str:
    group_id = getattr(event, "group_openid", None)
    if group_id:
        return f"group:{group_id}"
    return f"user:{event.get_user_id()}"


def get_history(key: str) -> list[dict[str, Any]]:
    return list(_conversations.get(key, []))


def push_history(key: str, message: dict[str, Any]) -> None:
    history = _conversations.setdefault(key, [])
    history.append(message)
    configured_max = Config.maxHistory
    try:
        max_len = max(2, int(configured_max))
    except (TypeError, ValueError):
        max_len = 20
    while len(history) > max_len:
        history.pop(0)


def reset_history(key: str) -> bool:
    return _conversations.pop(key, None) is not None


def reset_all_history() -> None:
    _conversations.clear()
