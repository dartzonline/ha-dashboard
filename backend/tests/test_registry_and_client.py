"""The registry snapshot's refresh behaviour and the HA REST client's history request shape."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app import entity_registry
from app.config import Settings
from app.entity_registry import RegistrySnapshot
from app.ha_client import HomeAssistantClient


class _FakeBridge:
    """Answers the three registry listings, slowly enough that concurrent callers overlap."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def send_command(self, command_type: str, **kwargs: Any) -> Any:
        self.calls.append(command_type)
        await asyncio.sleep(0.01)
        if command_type == "config/area_registry/list":
            return [{"area_id": "kitchen", "name": "Kitchen"}]
        if command_type == "config/device_registry/list":
            return [{"id": "dev1", "area_id": "kitchen"}]
        return [
            {"entity_id": "light.kitchen", "device_id": "dev1", "entity_category": None, "disabled_by": None, "hidden_by": None},
            {"entity_id": "sensor.rssi", "device_id": "dev1", "area_id": None, "entity_category": "diagnostic", "disabled_by": None, "hidden_by": "user"},
        ]


class TestRegistrySnapshot:
    def test_concurrent_first_reads_share_one_refresh(self):
        async def scenario():
            bridge = _FakeBridge()
            snapshot = RegistrySnapshot(bridge)  # type: ignore[arg-type]
            results = await asyncio.gather(*(snapshot.get() for _ in range(5)))
            assert len(bridge.calls) == 3  # entity, device, area -- once, not five times
            assert all(result == results[0] for result in results)
            return results[0]

        result = asyncio.run(scenario())
        assert result["areas"] == {"kitchen": "Kitchen"}
        assert result["entities"]["light.kitchen"]["areaId"] == "kitchen"  # inherited from its device
        assert result["entities"]["sensor.rssi"] == {
            "areaId": "kitchen", "category": "diagnostic", "disabled": False, "hidden": True, "deviceId": "dev1",
        }

    def test_the_three_registries_are_fetched_concurrently(self):
        """Three sequential 10 ms calls would take 30 ms; gathered, they take about one."""
        async def scenario():
            bridge = _FakeBridge()
            snapshot = RegistrySnapshot(bridge)  # type: ignore[arg-type]
            started = asyncio.get_running_loop().time()
            await snapshot.get()
            return asyncio.get_running_loop().time() - started

        assert asyncio.run(scenario()) < 0.025

    def test_a_fresh_snapshot_is_served_from_cache(self, monkeypatch):
        async def scenario():
            bridge = _FakeBridge()
            snapshot = RegistrySnapshot(bridge)  # type: ignore[arg-type]
            await snapshot.get()
            await snapshot.get()
            assert len(bridge.calls) == 3
            monkeypatch.setattr(entity_registry, "CACHE_TTL_S", 0.0)
            await snapshot.get()
            assert len(bridge.calls) == 6

        asyncio.run(scenario())


class TestHistoryRequest:
    def test_history_asks_for_no_attributes_and_a_minimal_response(self):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[[{"state": "on", "last_changed": "2025-01-01T00:00:00+00:00"}]])

        async def scenario():
            client = HomeAssistantClient(Settings(ha_url="http://ha", ha_token="tok", cors_origins=()))
            client.client = httpx.AsyncClient(base_url="http://ha", transport=httpx.MockTransport(handler), headers={"Authorization": "Bearer tok"})
            try:
                return await client.history_many(["light.a", "switch.b"], hours=6)
            finally:
                await client.close()

        series = asyncio.run(scenario())
        assert series[0][0]["state"] == "on"
        params = seen[0].url.params
        assert params["filter_entity_id"] == "light.a,switch.b"
        assert params["minimal_response"] == "true"
        assert params["no_attributes"] == "true"
        assert seen[0].headers["authorization"] == "Bearer tok"
