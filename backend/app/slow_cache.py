"""A tiny time-based cache for expensive reads (a week of history for hundreds of entities)."""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable

_store: dict[str, tuple[float, Any]] = {}


async def cached(key: str, ttl_s: float, loader: Callable[[], Awaitable[Any]]) -> Any:
    hit = _store.get(key)
    now = time.time()
    if hit is not None and now - hit[0] < ttl_s:
        return hit[1]
    value = await loader()
    _store[key] = (now, value)
    return value


def clear() -> None:
    _store.clear()
