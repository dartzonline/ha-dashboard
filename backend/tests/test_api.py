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


# ---------------------------------------------------------------------------------------------
# Service allowlist
# ---------------------------------------------------------------------------------------------

import httpx
import pytest

from app import dashboard_config, main


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    monkeypatch.setattr(dashboard_config, "_storage_path", lambda: tmp_path / "dashboard-config.json")
    return tmp_path


class TestServiceAllowlist:
    @pytest.mark.parametrize("domain,service", [
        ("light", "turn_on"), ("switch", "turn_off"), ("lock", "lock"), ("cover", "close_cover"),
        ("climate", "set_temperature"), ("fan", "set_percentage"), ("media_player", "media_next_track"),
        ("vacuum", "return_to_base"), ("update", "install"), ("button", "press"), ("scene", "turn_on"),
        ("script", "turn_on"), ("homeassistant", "turn_on"), ("homeassistant", "turn_off"), ("homeassistant", "toggle"),
    ])
    def test_everything_the_dashboard_calls_is_allowed(self, domain, service):
        response = client.post(f"/api/services/{domain}/{service}", json={"entity_id": f"{domain}.x"})
        assert response.status_code == 200, response.text
        assert response.json()[0]["domain"] == domain

    @pytest.mark.parametrize("domain,service", [
        ("shell_command", "anything"), ("python_script", "run"), ("hassio", "addon_restart"),
        ("homeassistant", "restart"), ("homeassistant", "stop"), ("homeassistant", "reload_core_config"),
        ("persistent_notification", "create"), ("recorder", "purge"), ("automation", "trigger"),
    ])
    def test_administrative_services_are_refused_with_a_403(self, domain, service):
        response = client.post(f"/api/services/{domain}/{service}", json={})
        assert response.status_code == 403
        assert response.json() == {"detail": f"Service {domain}.{service} is not allowed from the dashboard"}

    def test_odd_characters_in_the_name_are_refused_rather_than_forwarded(self):
        assert client.post("/api/services/Light/turn_on", json={}).status_code == 403
        assert client.post("/api/services/light/turn%20on", json={}).status_code == 403


# ---------------------------------------------------------------------------------------------
# Entity picture proxy
# ---------------------------------------------------------------------------------------------

class _PictureClient(FakeClient):
    """A fake HA client whose entity carries whichever `entity_picture` the test sets."""

    picture: str | None = None
    raw_calls: list[str] = []

    async def state(self, entity_id: str) -> dict[str, object]:
        return {"entity_id": entity_id, "state": "playing", "attributes": {"entity_picture": self.picture}}

    async def raw_get(self, path: str) -> httpx.Response:
        self.raw_calls.append(path)
        return httpx.Response(200, content=b"ha-bytes", headers={"content-type": "image/png"}, request=httpx.Request("GET", "http://ha" + path))


class TestEntityPicture:
    @pytest.fixture(autouse=True)
    def picture_client(self):
        _PictureClient.raw_calls = []
        app.dependency_overrides[get_client] = _PictureClient
        yield
        app.dependency_overrides[get_client] = FakeClient

    def test_a_relative_path_goes_through_the_authenticated_ha_client(self):
        _PictureClient.picture = "/api/media_player_proxy/media_player.tv?token=abc"
        response = client.get("/api/entity-picture/media_player.tv")
        assert response.status_code == 200
        assert response.content == b"ha-bytes"
        assert response.headers["content-type"] == "image/png"
        assert response.headers["cache-control"] == "private, max-age=300"
        assert _PictureClient.raw_calls == ["/api/media_player_proxy/media_player.tv?token=abc"]

    def test_an_absolute_url_is_fetched_without_the_ha_token(self, monkeypatch):
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, content=b"cdn-bytes", headers={"content-type": "image/jpeg"})

        plain = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(main, "get_http_client", lambda: plain)
        _PictureClient.picture = "https://i.scdn.co/image/abc"

        response = client.get("/api/entity-picture/media_player.spotify")
        assert response.status_code == 200
        assert response.content == b"cdn-bytes"
        assert response.headers["cache-control"] == "private, max-age=300"
        assert len(seen) == 1 and str(seen[0].url) == "https://i.scdn.co/image/abc"
        assert "authorization" not in {k.lower() for k in seen[0].headers}
        assert _PictureClient.raw_calls == []

    def test_an_oversized_external_picture_is_refused(self, monkeypatch):
        monkeypatch.setattr(main, "ENTITY_PICTURE_MAX_BYTES", 8)
        plain = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"0123456789")))
        monkeypatch.setattr(main, "get_http_client", lambda: plain)
        _PictureClient.picture = "https://example.com/big.jpg"
        response = client.get("/api/entity-picture/camera.big")
        assert response.status_code == 502

    def test_a_protocol_relative_or_data_url_is_not_fetched(self):
        for picture in ("//evil.example/x.png", "data:image/png;base64,AAAA", "ftp://x/y"):
            _PictureClient.picture = picture
            assert client.get("/api/entity-picture/camera.odd").status_code == 404
        assert _PictureClient.raw_calls == []


# ---------------------------------------------------------------------------------------------
# Dashboard config: validation and faithful round-trips
# ---------------------------------------------------------------------------------------------

class TestDashboardConfig:
    def test_a_zero_rate_and_an_empty_light_list_round_trip_faithfully(self, isolated_config):
        response = client.put("/api/config", json={"energyRatePerKwh": 0.0, "nightModeIndoorLights": [], "ignoredEntityIds": []})
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["energyRatePerKwh"] == 0.0
        assert body["nightModeIndoorLights"] == []
        assert body["ignoredEntityIds"] == []
        assert client.get("/api/config").json()["energyRatePerKwh"] == 0.0

    def test_absent_overrides_still_fall_back_to_defaults(self, isolated_config):
        body = client.get("/api/config").json()
        assert body["energyRatePerKwh"] == main.default_energy_rate()
        assert body["nightModeIndoorLights"] == sorted(main.NIGHT_MODE_INDOOR_LIGHTS_DEFAULT)

    def test_a_negative_rate_is_rejected(self, isolated_config):
        assert client.put("/api/config", json={"energyRatePerKwh": -0.1}).status_code == 422

    def test_a_nan_rate_is_rejected(self, isolated_config):
        response = client.put("/api/config", content='{"energyRatePerKwh": NaN}', headers={"content-type": "application/json"})
        assert response.status_code == 422
        assert not (isolated_config / "dashboard-config.json").exists()

    def test_night_mode_lights_must_be_light_entities(self, isolated_config):
        response = client.put("/api/config", json={"nightModeIndoorLights": ["light.ok", "switch.not_a_light"]})
        assert response.status_code == 422
        assert "switch.not_a_light" in response.text

    def test_saves_are_written_atomically(self, isolated_config):
        client.put("/api/config", json={"energyRatePerKwh": 0.2})
        assert sorted(p.name for p in isolated_config.iterdir()) == ["dashboard-config.json"]


# ---------------------------------------------------------------------------------------------
# Upstream error mapping and health
# ---------------------------------------------------------------------------------------------

class _RejectingClient(FakeClient):
    async def states(self):
        request = httpx.Request("GET", "http://ha/api/states")
        raise httpx.HTTPStatusError("401", request=request, response=httpx.Response(401, request=request))


class TestUpstreamErrors:
    def test_a_home_assistant_401_is_reported_as_a_502_about_the_backend_token(self):
        app.dependency_overrides[get_client] = _RejectingClient
        try:
            response = client.get("/api/states")
        finally:
            app.dependency_overrides[get_client] = FakeClient
        assert response.status_code == 502
        assert response.json() == {"detail": "Home Assistant rejected the backend's token"}


def test_health_reports_auth_failed() -> None:
    body = client.get("/api/health").json()
    assert body["home_assistant"]["auth_failed"] is False


def test_version_is_read_from_config_yaml(tmp_path) -> None:
    config = tmp_path / "config.yaml"
    config.write_text("name: Home Panel\nversion: 9.8.7\nslug: x\n")
    assert main.addon_version(config) == "9.8.7"
    assert main.addon_version(tmp_path / "missing.yaml") == "0.0.0"
    assert app.version not in ("", "0.0.0", "1.2.0")
