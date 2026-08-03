from fastapi.testclient import TestClient

from app.main import app, get_client, require_configuration


class FakeClient:
    async def health(self) -> bool:
        return True

    async def states(self) -> list[dict[str, str]]:
        return [{"entity_id": "light.kitchen", "state": "on"}]

    async def call_service(self, domain: str, service: str, data: dict[str, object]) -> list[dict[str, object]]:
        return [{"domain": domain, "service": service, "data": data}]


app.dependency_overrides[get_client] = FakeClient
app.dependency_overrides[require_configuration] = lambda: None
client = TestClient(app)


def test_health_has_connection_shape() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["home_assistant"]["connected"] is True


def test_config_exposes_ignored_entity_ids() -> None:
    """The discovery tray reads this key on every load; an absent override must not omit it."""
    response = client.get("/api/config")
    assert response.status_code == 200
    assert isinstance(response.json()["ignoredEntityIds"], list)


def test_service_requires_json_object() -> None:
    response = client.post("/api/services/light/turn_on", json=["not", "an", "object"])
    assert response.status_code == 422
