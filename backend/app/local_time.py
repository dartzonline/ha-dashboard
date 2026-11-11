"""The household's wall clock and units, from Home Assistant's core config.

The add-on container often runs in UTC, but "Wednesday after 4 pm" means the house's own time.
Home Assistant knows its time zone and unit system (`/api/config`); this asks once an hour and
falls back to the container's zone, and to US units, if Home Assistant cannot say.
"""

from __future__ import annotations

import time
from datetime import datetime, tzinfo
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

CONFIG_TTL_S = 3600.0
_cache: dict[str, Any] = {"config": None, "at": 0.0}

ConfigFn = Callable[[], Awaitable[dict[str, Any]]]


async def home_config(get_config: ConfigFn) -> dict[str, Any]:
    if _cache["config"] is not None and time.time() - _cache["at"] < CONFIG_TTL_S:
        return _cache["config"]
    try:
        config = await get_config()
    except Exception:  # noqa: BLE001 - Home Assistant down: use the fallbacks, ask again next time
        return {}
    _cache.update(config=config if isinstance(config, dict) else {}, at=time.time())
    return _cache["config"]


async def home_zone(get_config: ConfigFn) -> tzinfo:
    name = (await home_config(get_config)).get("time_zone")
    if isinstance(name, str) and name:
        try:
            return ZoneInfo(name)
        except (KeyError, ValueError):
            pass
    return datetime.now().astimezone().tzinfo or ZoneInfo("UTC")


async def home_is_imperial(get_config: ConfigFn) -> bool:
    units = (await home_config(get_config)).get("unit_system") or {}
    return units.get("temperature") != "°C"


def reset_cache() -> None:
    _cache.update(config=None, at=0.0)
