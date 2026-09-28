from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from .config import Settings


class HomeAssistantClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = httpx.AsyncClient(
            base_url=self.settings.ha_url,
            headers={"Authorization": f"Bearer {self.settings.ha_token}"},
            timeout=15,
            trust_env=False,
            # A wall dashboard fires many concurrent HA calls (states poll, several tiles'
            # history fetches, service calls) -- a 1-connection pool serialized all of them
            # through a single socket. Home Assistant's own HTTP API handles concurrent
            # requests fine, so this was pure self-inflicted queueing.
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )

    async def close(self) -> None:
        await self.client.aclose()

    async def health(self) -> bool:
        if not self.settings.configured:
            return False
        try:
            response = await self.client.get("/api/states/__healthcheck__.probe")
            return response.status_code in {200, 404}
        except httpx.HTTPError:
            return False

    async def states(self) -> list[dict[str, Any]]:
        response = await self.client.get("/api/states")
        response.raise_for_status()
        return response.json()

    async def state(self, entity_id: str) -> dict[str, Any]:
        response = await self.client.get(f"/api/states/{entity_id}")
        response.raise_for_status()
        return response.json()

    async def call_service(
        self, domain: str, service: str, data: dict[str, Any]
    ) -> list[dict[str, Any]]:
        response = await self.client.post(f"/api/services/{domain}/{service}", json=data)
        response.raise_for_status()
        return response.json()

    async def raw_get(self, path: str) -> httpx.Response:
        """Fetch an arbitrary Home-Assistant-relative path (e.g. an entity_picture) with auth attached."""
        return await self.client.get(path)

    async def history(self, entity_id: str, hours: int = 24) -> list[list[dict[str, Any]]]:
        return await self.history_many([entity_id], hours)

    async def history_many(self, entity_ids: list[str], hours: int = 24) -> list[list[dict[str, Any]]]:
        """History for several entities in one round trip.

        Home Assistant's history endpoint accepts a comma-separated `filter_entity_id` and returns
        one series per entity, which is the difference between one request and ninety-eight when
        summarising every device_tracker on the network.
        """
        start = datetime.now(timezone.utc) - timedelta(hours=hours)
        # Home Assistant treats both flags as present-or-absent -- `no_attributes=false` still
        # switched attributes *off*, so this was always attribute-free in practice. Every consumer
        # (sparklines, timelines, the network/health insights) reads only `state` and
        # `last_changed`/`last_updated`, and a 30-day series with attributes on every row is many
        # times the size, so asking for them would be pure bandwidth. `minimal_response` on top
        # trims the intermediate rows further (no entity_id/last_updated on unchanged rows).
        response = await self.client.get(
            f"/api/history/period/{start.isoformat()}",
            params={
                "filter_entity_id": ",".join(entity_ids),
                "minimal_response": "true",
                "no_attributes": "true",
            },
        )
        response.raise_for_status()
        return response.json()
