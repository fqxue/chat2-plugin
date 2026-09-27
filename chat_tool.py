"""对话模型的 agent 工具,移植自 apps/chat.js 中的工具定义。

三个工具的执行结果都是"直接发送给用户",成功后本轮对话不再让模型生成收尾文字。
"""

import base64
from dataclasses import dataclass, field
from typing import Any

from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .image_core import generate_image_base64
from .media_send import send_image
from .wallpaper_core import (
    fetch_wallpaper_buffer,
    get_wallpaper_original_urls,
    get_wallpaper_page,
)
from .wallpaper_render import send_wallpaper_preview

# 副作用工具:执行成功即终止本轮工具循环
TERMINAL_TOOLS = ("generate_image", "list_wallpapers", "download_wallpapers")

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": (
                "生成新图片,或编辑用户当前消息附带/引用的图片。"
                "仅在用户要求产出图片时调用;识图、描述、分析和问答直接使用模型视觉能力。"
                "参考图由插件自动读取,不需要也不能提供图片 URL。"
                "工具成功后会直接把图片发送给用户。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "minLength": 1,
                        "description": "要生成的图片描述,或对用户当前图片的编辑指令",
                    }
                },
                "required": ["prompt"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_wallpapers",
            "description": (
                "发送一页最新壁纸预览图,供用户浏览和挑选。"
                "用户已指定壁纸编号时不要调用本工具,应直接调用 download_wallpapers。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "page": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "要浏览的页码,默认 1(最新)",
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "download_wallpapers",
            "description": (
                "按全局编号把壁纸原图直接发送给用户。编号来自预览图,"
                "1 表示最新一张且自动跨页。用户给出编号时直接调用,不要先浏览或换算页码。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "indexes": {
                        "type": "array",
                        "items": {"type": "integer", "minimum": 1},
                        "minItems": 1,
                        "maxItems": 9,
                        "description": "要发送的壁纸全局编号,如 [25] 或 [1,2]",
                    }
                },
                "required": ["indexes"],
                "additionalProperties": False,
            },
        },
    },
]


@dataclass
class ToolContext:
    """工具执行上下文,跨工具调用共享状态。"""

    matcher: Matcher
    user_images: list[str]
    tool_sent_content: bool = False
    tool_history: list[str] = field(default_factory=list)
    last_tool_error: str = ""

    async def send_image(self, data: bytes, file_name: str) -> None:
        await send_image(self.matcher, data, file_name)


async def execute_tool(name: str, arguments: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """执行单个工具,返回作为 tool 消息发回模型的结果。"""
    try:
        if name == "generate_image":
            return await _generate_image(arguments, ctx)
        if name == "list_wallpapers":
            return await _list_wallpapers(arguments, ctx)
        if name == "download_wallpapers":
            return await _download_wallpapers(arguments, ctx)
        return {"error": f"未知工具: {name}"}
    except Exception as err:  # noqa: BLE001
        message = str(err) or repr(err)
        logger.error(f"[chat2] agent 工具 {name} 执行失败: {message}")
        ctx.last_tool_error = f"工具执行失败:{message}"
        return {"error": message}


async def _generate_image(arguments: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    image_prompt = str(arguments.get("prompt") or "").strip()
    if not image_prompt:
        raise RuntimeError("缺少 prompt")
    logger.info(f"[chat2] agent 图片工具开始执行(参考图 {len(ctx.user_images)} 张): {image_prompt}")
    b64 = await generate_image_base64(image_prompt, ctx.user_images)
    logger.info(f"[chat2] agent 图片工具执行完成,图片约 {round(len(b64) * 3 / 4 / 1024)} KB,立即发送")
    await ctx.send_image(base64.b64decode(b64), "chat2-tool.png")
    ctx.tool_sent_content = True
    ctx.tool_history.append(
        f"[已编辑并发送图片,参考图 {len(ctx.user_images)} 张]"
        if ctx.user_images
        else "[已生成并发送图片]"
    )
    return {
        "delivered": True,
        "type": "edited-image" if ctx.user_images else "generated-image",
        "referenceImageCount": len(ctx.user_images),
    }


async def _list_wallpapers(arguments: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    page = arguments.get("page") or 1
    page = int(page)
    page_data = await get_wallpaper_page(page)
    logger.info(f"[chat2] agent 壁纸预览工具: 第 {page_data['page']} 页")
    await send_wallpaper_preview(ctx.matcher, page_data)
    ctx.tool_sent_content = True
    ctx.tool_history.append(f"[已发送第 {page_data['page']} 页壁纸预览]")
    return {"delivered": True, "type": "wallpaper-preview", "page": page_data["page"]}


async def _download_wallpapers(arguments: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    indexes = [int(i) for i in (arguments.get("indexes") or [])]
    if not indexes:
        raise RuntimeError("缺少 indexes")
    urls = await get_wallpaper_original_urls(indexes)
    for url in urls:
        await ctx.send_image(await fetch_wallpaper_buffer(url), "wallpaper.jpg")
    ctx.tool_sent_content = True
    ctx.tool_history.append(f"[已发送壁纸原图:{', '.join(str(i) for i in indexes)}]")
    return {"delivered": True, "type": "wallpaper-originals", "indexes": indexes, "count": len(urls)}
