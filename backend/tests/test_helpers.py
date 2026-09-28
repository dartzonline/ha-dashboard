"""The two small shared helpers: crash-safe file writes and the bounded LRU cache.

Both back several modules (dashboard config, photo index, flight quota; every flight cache), so
their contracts are pinned here once rather than re-proven in each consumer's tests.
"""

from __future__ import annotations

import os

import pytest

from app.atomic import write_text_atomic
from app.bounded_cache import BoundedCache


class TestWriteTextAtomic:
    def test_writes_the_text_and_creates_missing_parents(self, tmp_path):
        target = tmp_path / "nested" / "deeper" / "file.json"
        write_text_atomic(target, '{"a": 1}')
        assert target.read_text() == '{"a": 1}'

    def test_replaces_existing_contents_in_full(self, tmp_path):
        target = tmp_path / "file.json"
        target.write_text("old contents that are longer")
        write_text_atomic(target, "new")
        assert target.read_text() == "new"

    def test_leaves_no_temp_file_behind_on_success(self, tmp_path):
        target = tmp_path / "file.json"
        write_text_atomic(target, "x")
        assert os.listdir(tmp_path) == ["file.json"]

    def test_a_failed_write_leaves_the_original_untouched_and_no_temp_file(self, tmp_path, monkeypatch):
        target = tmp_path / "file.json"
        target.write_text("original")

        def exploding_replace(src, dst):
            raise OSError("disk went away")

        monkeypatch.setattr("app.atomic.os.replace", exploding_replace)
        with pytest.raises(OSError):
            write_text_atomic(target, "new")
        assert target.read_text() == "original"
        assert os.listdir(tmp_path) == ["file.json"]


class TestBoundedCache:
    def test_behaves_like_a_dict_for_the_operations_callers_use(self):
        cache: BoundedCache[str, int] = BoundedCache(maxsize=4)
        cache["a"] = 1
        assert cache["a"] == 1
        assert cache.get("a") == 1
        assert cache.get("missing") is None
        assert cache.get("missing", "dflt") == "dflt"
        assert "a" in cache
        assert "b" not in cache
        assert len(cache) == 1
        assert cache.pop("a") == 1
        assert cache.pop("a", None) is None
        cache["x"] = 2
        cache.clear()
        assert len(cache) == 0

    def test_evicts_the_least_recently_used_entry_when_full(self):
        cache: BoundedCache[str, int] = BoundedCache(maxsize=2)
        cache["a"] = 1
        cache["b"] = 2
        cache["a"]  # touch -> "b" is now the oldest
        cache["c"] = 3
        assert "a" in cache
        assert "b" not in cache
        assert "c" in cache

    def test_overwriting_a_key_does_not_grow_the_cache(self):
        cache: BoundedCache[str, int] = BoundedCache(maxsize=2)
        cache["a"] = 1
        cache["a"] = 2
        cache["b"] = 3
        assert len(cache) == 2 and cache["a"] == 2

    def test_never_exceeds_maxsize_under_churn(self):
        cache: BoundedCache[int, int] = BoundedCache(maxsize=10)
        for i in range(1000):
            cache[i] = i
        assert len(cache) == 10
        assert list(cache) == list(range(990, 1000))

    def test_optional_ttl_expires_entries(self):
        now = [100.0]
        cache: BoundedCache[str, int] = BoundedCache(maxsize=4, ttl=10, clock=lambda: now[0])
        cache["a"] = 1
        now[0] += 5
        assert cache.get("a") == 1
        now[0] += 6
        assert cache.get("a") is None
        assert "a" not in cache
        assert len(cache) == 0

    def test_rejects_a_zero_size(self):
        with pytest.raises(ValueError):
            BoundedCache(maxsize=0)
