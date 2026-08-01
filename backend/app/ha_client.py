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
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
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

    async def history(self, entity_id: str, hours: int = 24) -> list[list[dict[str, Any]]]:
        start = datetime.now(timezone.utc) - timedelta(hours=hours)
        response = await self.client.get(
            f"/api/history/period/{start.isoformat()}",
            params={
                "filter_entity_id": entity_id,
                "minimal_response": "true",
                "no_attributes": "false",
            },
        )
        response.raise_for_status()
        return response.json()
