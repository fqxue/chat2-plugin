"""#ai 管理指令,移植自 apps/management.js(未移植 #ai更新)。

重置 / 重置全部 / 模型切换仅主人(superusers)可用,帮助所有人可用。
与原插件的差异:#ai模型 切换后会写回 config.yaml 持久化。
"""

import re

from nonebot import on_regex
from nonebot.adapters.qq import QQMessageEvent
from nonebot.exception import IgnoredException
from nonebot.internal.matcher import Matcher
from nonebot.log import logger

from .config import Config
from .history import history_key, reset_all_history, reset_history

# 模型 ID 由第二个分组捕获,避免再写一条几乎相同的正则
_MANAGE_RE = r"^#(?:ai|chatgpt)(重置全部|重置|帮助|help|模型\s*(\S+))$"
_SET_COOKIE_RE = r"^#设置抖音cookie\s+([\s\S]+)$"

_manage = on_regex(_MANAGE_RE, priority=1, block=True)
_set_douyin_cookie = on_regex(_SET_COOKIE_RE, priority=1, block=True)


@_manage.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    matched = event.get_plaintext().strip()
    logger.info(f"[chat2] 管理指令: {matched}")

    if matched.endswith(("帮助", "help")):
        cfg = Config.snapshot()
        trigger_desc = (
            "@机器人 + 内容(群里)或直接发送内容(私聊)"
            if cfg.get("toggleMode") == "at"
            else f"{cfg.get('togglePrefix')} + 内容"
        )
        await matcher.finish(
            "chat2 插件指令:\n"
            f"- {trigger_desc}:对话\n"
            "- #ai重置:清空当前会话历史\n"
            "- #ai重置全部:清空所有会话历史\n"
            "- #ai模型 <模型ID>:切换默认模型(自动保存)\n"
            "- #画图 <描述>:生成图片(需配置 image.model)\n"
            "- #改图 <指令>(附带/引用图片):编辑图片\n"
            "- #壁纸 [页码]:查看最新壁纸列表\n"
            "- #下载1(或 #下载1,2):发送壁纸原图(编号见 #壁纸)\n"
            "- Bilibili 视频链接:自动解析并发送视频\n"
            "- 群里使用以上指令需同时 @机器人;对话也可以直接说,"
            '如"来一张壁纸""画一只猫"\n'
            f"当前模型:{cfg.get('model')}\n"
            f"图片模型:{(cfg.get('image') or {}).get('model') or '未配置(图片功能不可用)'}\n"
            f"apiKey:{ '已配置' if cfg.get('apiKey') else '未配置(对话不可用)'}"
        )

    # 以下指令仅主人可用
    from nonebot import get_driver

    superusers = get_driver().config.superusers
    if event.get_user_id() not in superusers:
        raise IgnoredException("chat2: 非主人,忽略管理指令")

    if matched.endswith("重置全部"):
        reset_all_history()
        await matcher.finish("已重置所有会话的对话历史")
    if matched.endswith("重置"):
        reset_history(history_key(event))
        await matcher.finish("已重置当前会话的对话历史")
    # #ai模型 <模型ID>
    model_match = re.match(_MANAGE_RE, matched)
    model = model_match.group(2) if model_match else None
    if model:
        Config.model = model
        saved = Config.save()
        await matcher.finish(
            f"默认模型已切换为:{model}(已保存)"
            if saved
            else f"默认模型已切换为:{model},但配置文件写入失败,重启后会失效"
        )
    raise IgnoredException("chat2: 未匹配的管理指令")


@_set_douyin_cookie.handle()
async def _(matcher: Matcher, event: QQMessageEvent) -> None:
    from nonebot import get_driver

    superusers = get_driver().config.superusers
    if event.get_user_id() not in superusers:
        raise IgnoredException("chat2: 非主人,忽略设置抖音cookie指令")

    matched = re.match(_SET_COOKIE_RE, event.get_plaintext())
    # "cookie: " 前缀由 douyin_core.parse_share 统一剥离,这里只做收尾 trim
    cookie = matched.group(1).strip() if matched else ""
    if not cookie:
        await matcher.finish("用法:#设置抖音cookie <cookie字符串>")
    douyin_cfg = dict(Config.douyin or {})
    douyin_cfg["cookie"] = cookie
    Config.douyin = douyin_cfg
    saved = Config.save()
    logger.info(f"[chat2] 抖音 Cookie 已更新({len(cookie)} 字符)")
    await matcher.finish(
        f"抖音 Cookie 已设置({len(cookie)} 字符)"
        + (",已写入配置文件" if saved else ",但配置文件写入失败,重启后会失效")
    )
