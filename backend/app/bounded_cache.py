"""A dict that cannot grow without limit.

The flight tracker keeps a dozen module-level caches keyed by callsign, icao24, or a rounded
coordinate. Every one of them was a plain `dict`, and every key in them is chosen by whatever
aircraft happen to be overhead (or whatever a browser asks about) -- so on a long-running wall
panel they only ever grew. This is the same shape with an LRU bound: the least recently *used*
entry is dropped once the cache is full, so a busy-airspace panel that has been up for weeks holds
the same working set it would have after an hour.

Existing callers store `(fetched_at, value)` tuples and apply their own, per-cache TTL rules
(some distinguish a miss TTL from a hit TTL, one back-dates entries on error), so this deliberately
does not replace that logic. The optional `ttl` here is an additional, coarse expiry that lets a
cache forget entries nobody has asked about in a long time regardless of the caller's TTL. It is
a `MutableMapping`, so `cache[key]`, `cache.get(key)`, `key in cache`, `cache.pop(key, None)`,
`cache.clear()` and `len(cache)` all behave as they did with the dict it replaces.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Iterator, MutableMapping
from typing import Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class BoundedCache(MutableMapping[K, V], Generic[K, V]):
    def __init__(self, maxsize: int = 512, ttl: float | None = None, clock=time.monotonic) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be at least 1")
        self.maxsize = maxsize
        self.ttl = ttl
        self._clock = clock
        # key -> (stored_at, value). Insertion order doubles as recency order: a read moves the key
        # to the end, an eviction pops from the front.
        self._data: OrderedDict[K, tuple[float, V]] = OrderedDict()

    def _expired(self, stored_at: float) -> bool:
        return self.ttl is not None and (self._clock() - stored_at) >= self.ttl

    def __getitem__(self, key: K) -> V:
        stored_at, value = self._data[key]
        if self._expired(stored_at):
            del self._data[key]
            raise KeyError(key)
        self._data.move_to_end(key)
        return value

    def __setitem__(self, key: K, value: V) -> None:
        if key in self._data:
            self._data.move_to_end(key)
        self._data[key] = (self._clock(), value)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)

    def __delitem__(self, key: K) -> None:
        del self._data[key]

    def __contains__(self, key: object) -> bool:
        entry = self._data.get(key)  # type: ignore[arg-type]
        if entry is None:
            return False
        if self._expired(entry[0]):
            del self._data[key]  # type: ignore[arg-type]
            return False
        return True

    def __iter__(self) -> Iterator[K]:
        # Snapshot so callers can mutate while iterating, the same as they could over `dict.keys()`
        # only by accident before; expired keys are skipped rather than purged mid-iteration.
        return iter([key for key, (stored_at, _) in list(self._data.items()) if not self._expired(stored_at)])

    def __len__(self) -> int:
        if self.ttl is None:
            return len(self._data)
        return sum(1 for _, (stored_at, _) in self._data.items() if not self._expired(stored_at))

    def __repr__(self) -> str:
        return f"BoundedCache(maxsize={self.maxsize}, ttl={self.ttl}, size={len(self)})"
