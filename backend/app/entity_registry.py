"""Phase 0 of docs/auto-entity-discovery.md: registry metadata over the WebSocket API.

`/api/states` (ha_client.py) never exposes `entity_category`, `area_id`, or `disabled_by`/
`hidden_by` -- those live in Home Assistant's registries, reachable only over the WebSocket API.
This module fetches and joins the three registries needed to tell "a diagnostic RSSI sensor" apart
from "a tile worth showing", which is the actual hard part of automatic entity discovery. Nothing
here changes the dashboard yet -- see the design doc for the phases that build on it.
"""

import time
from typing import Any

from .event_bridge import EventBridge

CACHE_TTL_S = 300.0


class RegistrySnapshot:
    """A joined, minimal view of entity/device/area registries, cached in memory."""

    def __init__(self, bridge: EventBridge) -> None:
        self._bridge = bridge
        self._cached_at = 0.0
        self._entities: dict[str, dict[str, Any]] = {}
        self._areas: dict[str, str] = {}

    async def get(self) -> dict[str, Any]:
        now = time.time()
        if now - self._cached_at < CACHE_TTL_S and self._cached_at > 0:
            return {"entities": self._entities, "areas": self._areas}
        await self._refresh()
        self._cached_at = now
        return {"entities": self._entities, "areas": self._areas}

    async def _refresh(self) -> None:
        entity_rows, device_rows, area_rows = [
            await self._bridge.send_command(f"config/{kind}_registry/list")
            for kind in ("entity", "device", "area")
        ]

        areas: dict[str, str] = {}
        for row in area_rows if isinstance(area_rows, list) else []:
            if not isinstance(row, dict):
                continue
            area_id = row.get("area_id")
            name = row.get("name")
            if isinstance(area_id, str) and isinstance(name, str):
                areas[area_id] = name

        device_areas: dict[str, str | None] = {}
        for row in device_rows if isinstance(device_rows, list) else []:
            if not isinstance(row, dict):
                continue
            device_id = row.get("id")
            if isinstance(device_id, str):
                area_id = row.get("area_id")
                device_areas[device_id] = area_id if isinstance(area_id, str) else None

        entities: dict[str, dict[str, Any]] = {}
        for row in entity_rows if isinstance(entity_rows, list) else []:
            if not isinstance(row, dict):
                continue
            entity_id = row.get("entity_id")
            if not isinstance(entity_id, str):
                continue
            device_id = row.get("device_id")
            area_id = row.get("area_id")
            if not isinstance(area_id, str) and isinstance(device_id, str):
                area_id = device_areas.get(device_id)
            entities[entity_id] = {
                "areaId": area_id if isinstance(area_id, str) else None,
                "category": row.get("entity_category"),
                "disabled": row.get("disabled_by") is not None,
                "hidden": row.get("hidden_by") is not None,
                "deviceId": device_id if isinstance(device_id, str) else None,
            }

        self._entities = entities
        self._areas = areas
