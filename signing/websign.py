"""Douyin visitor signature, adapted from DTK commit 737bf3d (Apache-2.0).

Modified to retain only the signing functions needed by this plugin.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterable, Mapping, Sequence
from urllib.parse import quote

SALT = "A96D855A08C0A9707F8BEF0D9A527E4E"
UIFID_COOKIE_NAMES = ("uifid", "uifid_temp", "uifidtemp", "UIFID", "UIFID_TEMP", "UIFIDTEMP")
VERIFY_FP_COOKIE = "s_v_web_id"
SIGNATURE_PARAM = "x-secsdk-web-signature"
UIFID_PARAM = "uifid"
TIMESTAMP_PARAM = "timestamp"
VERIFY_FP_PARAMS = ("verifyFp", "fp")
EXPIRE_HEADER = "x-secsdk-web-expire"


def pick_uifid(cookies: Mapping[str, str] | None) -> str | None:
    for name in UIFID_COOKIE_NAMES:
        if (value := (cookies or {}).get(name)):
            return value
    return None


def encode_pairs(pairs: Iterable[tuple[str, str]]) -> str:
    return "&".join(f"{quote(k, safe='*-._')}={quote(v, safe='*-._')}" for k, v in pairs)


def sign(
    pairs: Sequence[tuple[str, str]], uifid: str, *, timestamp: int | None = None
) -> tuple[str, str, dict[str, str]]:
    stamp = str(int(time.time() if timestamp is None else timestamp))
    covered = list(pairs)
    if not any(name == UIFID_PARAM for name, _ in covered):
        covered.append((UIFID_PARAM, uifid))
    covered.append((TIMESTAMP_PARAM, stamp))
    query = encode_pairs(covered)
    signature = hashlib.md5(f"{uifid}_{stamp}_{SALT}_{query}".encode()).hexdigest()
    return (
        f"{query}&{SIGNATURE_PARAM}={signature}",
        signature,
        {UIFID_PARAM: uifid, SIGNATURE_PARAM: signature, EXPIRE_HEADER: stamp},
    )
