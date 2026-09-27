"""壁纸预览图渲染:用 Pillow 画网格预览图,替代原插件的 Yunzai HTML 截图(models/render.js)。

版式复刻原 buildPreviewHtml:1170 宽、3 列卡片、9:16 缩略图、编号角标、米色渐变背景。
"""

import asyncio
import io
import os
from pathlib import Path
from typing import Any

from nonebot.adapters.qq.models import (
    Action,
    Button,
    InlineKeyboard,
    InlineKeyboardRow,
    MessageKeyboard,
    Permission,
    RenderData,
)
from nonebot.adapters.qq import Message, MessageSegment
from nonebot.internal.matcher import Matcher
from nonebot.log import logger
from PIL import Image, ImageDraw, ImageFont, ImageOps

from .media_send import send_image
from .wallpaper_core import fetch_wallpaper_buffer

# 按钮回调回传的数据前缀,用于识别"壁纸按钮"的 INTERACTION_CREATE 事件
BUTTON_DATA_PREFIX = "chat2:wp:"
# 翻页按钮的数据前缀
PAGE_BUTTON_PREFIX = "chat2:wppage:"
# 每行按钮数,与预览图 3 列网格对应
BUTTONS_PER_ROW = 3
# 按钮必填字段:style(0 灰色线框)与 permission.type(2 表示所有人可操作)。
# 缺 permission 时服务端会拒绝点击,客户端提示"无权限操作"
BUTTON_STYLE = 0
BUTTON_PERMISSION_ALL = 2
BUTTON_UNSUPPORT_TIPS = "当前客户端不支持按钮,请直接发送 #下载编号"
# 按钮提示文案:带 keyboard 时正文必须是 markdown 段
WALLPAPER_BUTTON_TIP = (
    "点击编号按钮发送对应壁纸原图,点上一页/下一页翻页(按钮不可用时直接发 #下载编号)"
)

CANVAS_WIDTH = 1170
PADDING = 20
GRID_GAP = 14
CARD_PADDING = 8
CARD_RADIUS = 16
THUMB_RADIUS = 12
COLS = 3

BG_TOP = (247, 242, 232)
BG_BOTTOM = (243, 239, 231)
CARD_BG = (255, 253, 248)
CARD_BORDER = (221, 210, 194)
TEXT_MAIN = (31, 31, 35)
TEXT_SUB = (107, 102, 95)
PLACEHOLDER_BG = (216, 207, 190)
BADGE_BG = (17, 18, 20)

# 覆盖常见发行版:CentOS/RHEL 多见 noto-cjk,Debian/Ubuntu 多见 opentype/noto 与 wqy
_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",  # 微软雅黑 Bold
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
    "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
# 兜底:CHAT2_FONT_FILE 直接指定一个 TTF/TTC
_FONT_FILE_ENV = "CHAT2_FONT_FILE"

_font_cache: dict[int, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font = _font_cache.get(size)
    if font is None:
        env_font = os.environ.get(_FONT_FILE_ENV, "").strip()
        candidates = ([env_font] if env_font else []) + list(_FONT_CANDIDATES)
        for candidate in candidates:
            if Path(candidate).exists():
                try:
                    font = ImageFont.truetype(candidate, size)
                    break
                except OSError:
                    continue
        else:
            logger.warning(
                f"[chat2] 未找到中文字体,预览图中文将无法正常显示;"
                f"请安装 noto-cjk/wqy 字体或用 {_FONT_FILE_ENV} 指定字体文件"
            )
            font = ImageFont.load_default()
        _font_cache[size] = font
    return font


def _vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    width, height = size
    gradient = Image.new("RGB", (1, height))
    for y in range(height):
        ratio = y / max(1, height - 1)
        gradient.putpixel(
            (0, y),
            tuple(int(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3)),
        )
    return gradient.resize((width, height))


def _rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def _draw_card(
    draw: ImageDraw.ImageDraw,
    base: Image.Image,
    item: dict[str, Any],
    box: tuple[int, int, int, int],
    thumb: Image.Image | None,
) -> None:
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=CARD_RADIUS, fill=CARD_BG, outline=CARD_BORDER, width=1)

    tx0, ty0 = x0 + CARD_PADDING, y0 + CARD_PADDING
    tx1 = x1 - CARD_PADDING
    thumb_h = int((tx1 - tx0) * 16 / 9)
    ty1 = min(ty0 + thumb_h, y1 - CARD_PADDING)

    if thumb is not None:
        fitted = ImageOps.fit(thumb.convert("RGB"), (tx1 - tx0, ty1 - ty0), Image.LANCZOS)
        base.paste(fitted, (tx0, ty0), _rounded_mask(fitted.size, THUMB_RADIUS))
    else:
        draw.rounded_rectangle(
            (tx0, ty0, tx1, ty1), radius=THUMB_RADIUS, fill=PLACEHOLDER_BG
        )
        label = "加载失败"
        font = _load_font(14)
        lx = tx0 + ((tx1 - tx0) - draw.textlength(label, font=font)) / 2
        ly = ty0 + ((ty1 - ty0) - 14) / 2
        draw.text((lx, ly), label, font=font, fill=TEXT_SUB)

    # 编号角标(黑色圆角)
    badge_font = _load_font(16)
    badge_text = str(item["index"])
    badge_w = int(draw.textlength(badge_text, font=badge_font)) + 24
    badge_box = (tx0 + 6, ty0 + 6, tx0 + 6 + badge_w, ty0 + 32)
    draw.rounded_rectangle(badge_box, radius=13, fill=BADGE_BG)
    draw.text(
        (badge_box[0] + 12, badge_box[1] + (26 - 16) / 2),
        badge_text, font=badge_font, fill=(255, 255, 255),
    )

    # 底部信息:编号. code / 日期
    meta_font = _load_font(15)
    date_font = _load_font(13)
    meta_y = ty1 + 8
    draw.text((tx0 + 4, meta_y), f'{item["index"]}. {item["code"]}', font=meta_font, fill=TEXT_MAIN)
    draw.text((tx0 + 4, meta_y + 22), item["dayStr"], font=date_font, fill=TEXT_SUB)


async def _load_thumbs(items: list[dict[str, Any]], limit: int = 4) -> list[Image.Image | None]:
    """有限并发下载缩略图(避免一次打满 CDN 连接触发限流),失败返回 None。"""
    semaphore = asyncio.Semaphore(limit)
    results: list[Image.Image | None] = [None] * len(items)

    async def worker(index: int, item: dict[str, Any]) -> None:
        url = item.get("thumbUrl") or item.get("originalUrl")
        if not url:
            return
        async with semaphore:
            try:
                buffer = await fetch_wallpaper_buffer(url)
                image = Image.open(io.BytesIO(buffer))
                # 立即解码:截断/损坏的图片在这里就暴露,退化成占位图,
                # 而不是留到绘制阶段再抛异常把整页预览带崩
                image.load()
                results[index] = image
            except Exception as err:  # noqa: BLE001
                logger.warning(f"[chat2] 壁纸缩略图下载失败(#{item['index']}): {err}")

    await asyncio.gather(*(worker(i, item) for i, item in enumerate(items)))
    return results


def build_wallpaper_keyboard(
    items: list[dict[str, Any]],
    page: int = 1,
    total_pages: int = 1,
) -> MessageKeyboard | None:
    """预览图配套按钮:每张壁纸一个(3 个一行),最后一行为上一页/下一页。"""
    buttons: list[Button] = []
    for item in items:
        index = item.get("index")
        if not isinstance(index, int) or isinstance(index, bool):
            continue
        label = f"{index} 号"
        buttons.append(
            Button(
                id=f"wp{index}",
                render_data=RenderData(
                    label=label, visited_label=f"{label} ✓", style=BUTTON_STYLE
                ),
                # type=1 为回调按钮,data 会原样通过 INTERACTION_CREATE 回传
                action=Action(
                    type=1,
                    permission=Permission(type=BUTTON_PERMISSION_ALL),
                    data=f"{BUTTON_DATA_PREFIX}{index}",
                    unsupport_tips=BUTTON_UNSUPPORT_TIPS,
                ),
            )
        )
    if not buttons:
        return None

    rows = [
        InlineKeyboardRow(buttons=buttons[i:i + BUTTONS_PER_ROW])
        for i in range(0, len(buttons), BUTTONS_PER_ROW)
    ]
    nav: list[Button] = []
    if page > 1:
        nav.append(
            Button(
                id="prev",
                render_data=RenderData(
                    label="上一页", visited_label="上一页 ✓", style=BUTTON_STYLE
                ),
                action=Action(
                    type=1,
                    permission=Permission(type=BUTTON_PERMISSION_ALL),
                    data=f"{PAGE_BUTTON_PREFIX}{page - 1}",
                    unsupport_tips=BUTTON_UNSUPPORT_TIPS,
                ),
            )
        )
    if page < total_pages:
        nav.append(
            Button(
                id="next",
                render_data=RenderData(
                    label="下一页", visited_label="下一页 ✓", style=BUTTON_STYLE
                ),
                action=Action(
                    type=1,
                    permission=Permission(type=BUTTON_PERMISSION_ALL),
                    data=f"{PAGE_BUTTON_PREFIX}{page + 1}",
                    unsupport_tips=BUTTON_UNSUPPORT_TIPS,
                ),
            )
        )
    if nav:
        rows.append(InlineKeyboardRow(buttons=nav))
    return MessageKeyboard(content=InlineKeyboard(rows=rows))


async def send_wallpaper_preview(matcher: Matcher, page_data: dict[str, Any]) -> None:
    """发送某一页的预览图,再单独发一条挂按钮的 markdown 消息。

    QQ 的 keyboard 只能挂在 markdown 消息(msg_type=2)上,而 media 只在
    msg_type=7 时才生效,两者无法合成一条,所以预览图与按钮必须分两条发。
    """
    preview = await render_wallpaper_preview(page_data)
    await send_image(matcher, preview, f"wallpaper-page-{page_data['page']}.jpg")

    keyboard = build_wallpaper_keyboard(
        page_data["items"],
        page=int(page_data.get("page") or 1),
        total_pages=int(page_data.get("totalPages") or 1),
    )
    if keyboard is None:
        return
    try:
        await matcher.send(
            Message(
                [MessageSegment.markdown(WALLPAPER_BUTTON_TIP), MessageSegment.keyboard(keyboard)]
            )
        )
    except Exception as err:  # noqa: BLE001
        # 按钮是增强项,失败时不影响已经发出的预览图
        logger.warning(f"[chat2] 壁纸按钮发送失败(预览图已发出): {err}")


async def render_wallpaper_preview(page_data: dict[str, Any]) -> bytes:
    """把某一页壁纸数据渲染为预览图字节(JPEG)。"""
    items: list[dict[str, Any]] = page_data["items"]
    thumbs = await _load_thumbs(items)

    title_font = _load_font(30)
    sub_font = _load_font(16)

    card_width = (CANVAS_WIDTH - PADDING * 2 - GRID_GAP * (COLS - 1)) // COLS
    inner_w = card_width - CARD_PADDING * 2
    card_body = int(inner_w * 16 / 9) + 8 + 22 + 22  # 缩略图 + 间距 + 两行文字
    card_height = CARD_PADDING * 2 + card_body

    rows = -(-len(items) // COLS)
    title_block = 30 + 6 + 20 + 16  # 标题 + 间距 + 副标题 + 间距
    canvas_height = PADDING + title_block + rows * card_height + (rows - 1) * GRID_GAP + PADDING

    base = _vertical_gradient((CANVAS_WIDTH, canvas_height), BG_TOP, BG_BOTTOM)
    draw = ImageDraw.Draw(base)

    title = f'最新壁纸预览 第 {page_data["page"]} / {page_data["totalPages"]} 页'
    draw.text((PADDING, PADDING), title, font=title_font, fill=TEXT_MAIN)
    draw.text(
        (PADDING, PADDING + 36),
        "发送 #下载编号 获取原图,如 #下载1、#下载1,2",
        font=sub_font, fill=TEXT_SUB,
    )

    grid_y = PADDING + title_block
    for i, item in enumerate(items):
        row, col = divmod(i, COLS)
        x0 = PADDING + col * (card_width + GRID_GAP)
        y0 = grid_y + row * (card_height + GRID_GAP)
        _draw_card(draw, base, item, (x0, y0, x0 + card_width, y0 + card_height), thumbs[i])

    output = io.BytesIO()
    base.save(output, format="JPEG", quality=90)
    return output.getvalue()
