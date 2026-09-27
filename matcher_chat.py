"""对话 matcher,移植自 apps/chat.js。

私聊始终响应;群聊 @机器人(平台保证 to_me)或 prefix 模式下用 #chat 前缀。
带图片时用 image_url content part 传给视觉模型;
启用工具时最多 3 步的工具调用循环,副作用工具投递成功即停。
"""

import json
from typing import Any

from nonebot import Bot, on_message
from nonebot.adapters import Event
from nonebot.exception import IgnoredException
from nonebot.adapters.qq import C2CMessageCreateEvent, QQMessageEvent
from nonebot.internal.matcher import Matcher
from nonebot.log import logger
from nonebot.rule import Rule
from nonebot.typing import T_State

from .chat_tool import TERMINAL_TOOLS, TOOL_SCHEMAS, ToolContext, execute_tool
from .config import Config
from .history import get_history, history_key, push_history
from .image_core import collect_event_images, resolve_images
from .llm import get_chat_client, normalize_timeout

# 已提示过 apiKey 未配置的会话,避免私聊每条消息都刷警告
_api_key_warned: set[str] = set()


def _extract_user_text(text: str) -> str:
    """剥离触发前缀(at 模式下用前缀触发同样剥离)。"""
    text = (text or "").strip()
    prefix = Config.togglePrefix
    if prefix and text.startswith(prefix):
        text = text[len(prefix):].strip()
    return text


def _as_int(value: Any, default: int) -> int:
    """配置里的数字可能被手写成字符串,统一转换,非法值退回默认值。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _remember(key: str, user_text: str, reply: str) -> None:
    """记录一轮问答;历史中只保留纯文本,避免图片 URL 膨胀。"""
    push_history(key, {"role": "user", "content": user_text or "[图片]"})
    push_history(key, {"role": "assistant", "content": reply})


async def _chat_rule(bot: Bot, event: Event, state: T_State) -> bool:
    if not isinstance(event, QQMessageEvent):
        return False
    text = event.get_plaintext().strip()
    if Config.toggleMode == "prefix":
        if not (Config.togglePrefix and text.startswith(Config.togglePrefix)):
            return False
    # at 模式:私聊始终响应(私聊无法 @),群聊依赖适配器的 to_me 标记;
    # 两种模式都额外允许用 togglePrefix 前缀触发
    elif not (
        isinstance(event, C2CMessageCreateEvent)
        or event.is_tome()
        or (bool(Config.togglePrefix) and text.startswith(Config.togglePrefix))
    ):
        return False

    # 不认识的 # 指令不进入对话:本 matcher 直接不匹配,交给其它插件处理。
    # 在 rule 里过滤(而不是运行后抛 IgnoredException)可以避免无谓的 matcher 调度与报错日志
    if _extract_user_text(text).startswith("#"):
        return False
    # 既没有文字也没有图片同样不进入对话
    return bool(_extract_user_text(text)) or bool(collect_event_images(event))


_chat = on_message(Rule(_chat_rule), priority=10, block=True)


@_chat.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    # 触发条件(含"# 指令不进入对话""空消息不进入对话")已在 _chat_rule 中过滤
    user_text = _extract_user_text(event.get_plaintext())
    user_images = collect_event_images(event)

    key = history_key(event)
    if not Config.apiKey:
        if key not in _api_key_warned:
            _api_key_warned.add(key)
            tip = (
                "chat2 尚未配置 apiKey,请联系主人在 plugins/chat2/config/config.yaml 中配置"
            )
            # 图片走独立的 image.apiKey/baseURL,不受对话 apiKey 缺失影响
            tip += (
                "(#画图/#改图 使用独立配置,不受影响)"
                if (Config.image or {}).get("model")
                else "。"
            )
            await matcher.finish(tip)
        raise IgnoredException("chat2: 已提示过未配置 apiKey")
    _api_key_warned.discard(key)

    cfg = Config.snapshot()
    messages: list[dict[str, Any]] = get_history(key)
    if user_images:
        content: Any = [
            {
                "type": "image_url",
                "image_url": {"url": url},
            }
            for url in await resolve_images(user_images)
        ]
        content.append({"type": "text", "text": user_text or "请描述这张图片"})
    else:
        content = user_text
    messages.append({"role": "user", "content": content})

    logger.info(f"[chat2] 进入对话: {user_text}")

    ctx = ToolContext(matcher=matcher, user_images=user_images)
    image_cfg = cfg.get("image") or {}
    image_enabled = bool(image_cfg.get("model"))
    wallpaper_cfg = cfg.get("wallpaper") or {}
    wallpaper_enabled = bool(wallpaper_cfg.get("enable", True))
    tools = list(TOOL_SCHEMAS)
    if not (image_enabled and image_cfg.get("asTool", True)):
        tools = [t for t in tools if t["function"]["name"] != "generate_image"]
    if not wallpaper_enabled:
        tools = [
            t for t in tools
            if t["function"]["name"] not in ("list_wallpapers", "download_wallpapers")
        ]

    # 工具规则注入系统提示(对齐原插件)
    tool_rule: list[str] = []
    if image_enabled and image_cfg.get("asTool", True):
        tool_rule.append(
            '当用户要求"生成、画、创作"一张新图片,或对已有图片进行"编辑、重绘、改风格、'
            '改背景、P图"等修改并产出新图片时,你必须调用 generate_image 工具来完成;'
            "在未调用工具之前,严禁声称图片已生成、已完成,或描述\"生成的\"图片内容。"
        )
    if wallpaper_enabled:
        tool_rule.append(
            "当用户想浏览壁纸时调用 list_wallpapers;用户给出编号索要壁纸时直接调用 "
            "download_wallpapers,不能先调用列表工具。"
        )
    system_prompt = (cfg.get("systemPrompt") or "").strip()
    if tool_rule:
        system_prompt += (
            f"\n\n[工具规则] {''.join(tool_rule)}注意区分:用户仅仅发图片让你看图、识别、描述、"
            "分析、回答问题时,这是你自带的视觉能力,不要调用工具,直接基于看到的图片回答。"
            "工具会直接把结果发送给用户,调用成功后不需要再生成确认文字。"
        )

    # agent 模式下图片生成可能耗时数分钟,整体超时 = 对话超时 + 图片工具预算 + 缓冲
    base_timeout = normalize_timeout(cfg.get("timeout"), 120000)
    overall_timeout = base_timeout
    if tools:
        image_timeout = (
            normalize_timeout(image_cfg.get("timeout"), 180000)
            if image_enabled and image_cfg.get("asTool", True)
            else 0
        )
        overall_timeout = base_timeout + image_timeout + 60

    client = get_chat_client()
    request_kwargs: dict[str, Any] = {
        "model": cfg.get("model"),
        "messages": ([{"role": "system", "content": system_prompt}] if system_prompt else [])
        + messages,
        "timeout": overall_timeout,
    }
    if tools:
        request_kwargs["tools"] = tools
        request_kwargs["tool_choice"] = "auto"
    max_tokens = _as_int(cfg.get("maxTokens"), 0)
    if max_tokens > 0:
        request_kwargs["max_tokens"] = max_tokens
    temperature = _as_float(cfg.get("temperature"), -1.0)
    if temperature >= 0:
        request_kwargs["temperature"] = temperature

    text = ""
    try:
        # 工具调用循环:最多 3 步;副作用工具投递成功即停
        for _ in range(3):
            response = await client.chat.completions.create(**request_kwargs)
            choice = response.choices[0]
            message = choice.message
            if not message.tool_calls:
                text = (message.content or "").strip()
                break
            # 执行工具
            terminal_delivered = False
            tool_results: list[dict[str, Any]] = []
            for tool_call in message.tool_calls:
                try:
                    arguments = json.loads(tool_call.function.arguments or "{}")
                except json.JSONDecodeError:
                    arguments = {}
                result = await execute_tool(tool_call.function.name, arguments, ctx)
                logger.info(f"[chat2] 工具 {tool_call.function.name} 结果: {result}")
                if (
                    tool_call.function.name in TERMINAL_TOOLS
                    and result.get("delivered")
                ):
                    terminal_delivered = True
                tool_results.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )
            if terminal_delivered:
                # 副作用工具的结果就是本轮最终响应,不再请求模型
                break
            # 把助手消息与工具结果追加进对话,继续循环
            request_kwargs["messages"].append(message.model_dump(exclude_unset=True))
            request_kwargs["messages"].extend(tool_results)
    except Exception as err:  # noqa: BLE001
        if ctx.tool_sent_content:
            logger.warning(f"[chat2] 工具结果已发送,忽略后续错误: {err}")
        elif ctx.last_tool_error:
            logger.warning(f"[chat2] 工具失败后模型又报错,优先回复工具错误: {err}")
        else:
            logger.error(f"[chat2] 对话失败: {err}")
            await matcher.finish(f"对话出错了:{err}")

    if ctx.last_tool_error and not ctx.tool_sent_content:
        _remember(key, user_text, ctx.last_tool_error)
        await matcher.finish(ctx.last_tool_error)
    if ctx.tool_sent_content:
        _remember(key, user_text, "\n".join(ctx.tool_history) or "[工具结果已发送]")
        await matcher.finish()
    if text:
        _remember(key, user_text, text)
        await matcher.finish(text)
    await matcher.finish("模型没有返回内容")
