from fastapi.testclient import TestClient

from app.main import app, get_client, require_configuration


class FakeClient:
    async def health(self) -> bool:
        return True

    async def config(self) -> dict[str, object]:
        return {"time_zone": "America/New_York", "unit_system": {"temperature": "°F"}}

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

    def test_auto_off_settings_default_save_and_apply(self, isolated_config):
        from app import house_watch

        try:
            first = client.get("/api/config").json()
            assert first["lightAutoOffMinutes"] == 240
            assert first["lightAutoOffExcludedIds"] == ["light.my_rest_clock"]

            saved = client.put("/api/config", json={"lightAutoOffMinutes": 90, "lightAutoOffExcludedIds": []}).json()
            assert saved["lightAutoOffMinutes"] == 90 and saved["lightAutoOffExcludedIds"] == []
            assert house_watch.current_settings().light_auto_off_s == 90 * 60
            assert client.get("/api/config").json()["lightAutoOffExcludedIds"] == []

            assert client.delete("/api/config").json()["lightAutoOffMinutes"] == 240
            assert house_watch.current_settings() == house_watch.WatchSettings()
        finally:
            house_watch.apply_settings(house_watch.WatchSettings())

    @pytest.mark.parametrize("body", [
        {"lightAutoOffMinutes": 0}, {"lightAutoOffMinutes": 1441}, {"lightAutoOffMinutes": 1.5},
        {"lightAutoOffExcludedIds": ["switch.nope"]},
    ])
    def test_bad_auto_off_settings_are_rejected(self, isolated_config, body):
        assert client.put("/api/config", json=body).status_code == 422

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


class _LeftOnClient:
    calls: list[tuple[str, str, object]] = []

    async def states(self) -> list[dict[str, object]]:
        from datetime import datetime, timedelta, timezone

        long_ago = (datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()
        return [
            {"entity_id": "light.kitchen", "state": "on", "last_changed": long_ago, "attributes": {}},
            {"entity_id": "light.hall", "state": "on", "last_changed": long_ago, "attributes": {}},
            {"entity_id": "lock.front_door", "state": "unlocked", "last_changed": long_ago, "attributes": {}},
        ]

    async def call_service(self, domain: str, service: str, data: dict[str, object]) -> list[dict[str, object]]:
        _LeftOnClient.calls.append((domain, service, data["entity_id"]))
        return []


class TestTurnOffLeftOn:
    def test_requires_confirmation(self):
        assert client.post("/api/actions/turn-off-left-on", json={}).status_code == 400

    def test_switches_off_lights_but_leaves_the_lock_alone(self):
        _LeftOnClient.calls = []
        app.dependency_overrides[get_client] = _LeftOnClient
        try:
            response = client.post("/api/actions/turn-off-left-on", json={"confirm": True})
        finally:
            app.dependency_overrides[get_client] = FakeClient
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "completed"
        assert sorted(body["turnedOff"]) == ["light.hall", "light.kitchen"]
        assert _LeftOnClient.calls == [("light", "turn_off", body["turnedOff"])]


class _MorningClient(FakeClient):
    async def states(self) -> list[dict[str, object]]:
        return [{"entity_id": "zone.home", "state": "0", "attributes": {"latitude": 40.0, "longitude": -75.0}}]


class TestMorningBrief:
    def test_combines_forecast_and_house(self, monkeypatch):
        from app import weather_advice
        from tests.test_weather_advice import NOW, forecast

        async def fake_fetch(_client, latitude, longitude):
            assert (latitude, longitude) == (40.0, -75.0)
            return forecast(lambda day, hour: {"gust": 70.0} if day == 1 and hour == 14 else None)

        monkeypatch.setattr(weather_advice, "fetch_forecast", fake_fetch)
        monkeypatch.setattr(weather_advice.time, "time", lambda: NOW)
        app.dependency_overrides[get_client] = _MorningClient
        try:
            body = client.get("/api/insights/morning?units=metric").json()
        finally:
            app.dependency_overrides[get_client] = FakeClient
        assert body["forecastError"] is None
        assert body["today"]["date"] == "2026-11-10"
        assert [item["id"] for item in body["advice"]] == ["wind:tomorrow"]
        assert body["days"][0]["label"] == "Tomorrow"
        assert body["findings"] == [] and body["leftOn"] == []

    def test_without_a_location_still_answers(self):
        body = client.get("/api/insights/morning").json()
        assert body["forecastError"] == "Home Assistant has no home location"
        assert body["advice"] == []


class TestRemindersAndNotifications:
    def test_bin_schedule_and_notification_settings_round_trip(self, isolated_config):
        defaults = client.get("/api/config").json()
        assert defaults["binSchedule"]["trashWeekday"] == 3
        assert defaults["binSchedule"]["recyclingAnchorDate"] == "2026-11-19"
        assert defaults["notifications"]["targets"] == []
        saved = client.put("/api/config", json={
            "binSchedule": {"trashWeekday": 3, "recycling": "biweekly", "recyclingAnchorDate": "2026-11-19",
                            "remindStart": "16:00", "remindEnd": "22:00", "intervalMinutes": 30},
            "notifications": {"targets": ["notify.mobile_app_pixel"], "weekly": False},
        }).json()
        assert saved["notifications"]["targets"] == ["notify.mobile_app_pixel"]
        assert saved["notifications"]["weekly"] is False

    @pytest.mark.parametrize("body", [
        {"binSchedule": {"trashWeekday": 7}}, {"binSchedule": {"remindStart": "4pm"}},
        {"binSchedule": {"intervalMinutes": 5}}, {"notifications": {"targets": ["light.kitchen"]}},
    ])
    def test_bad_reminder_settings_are_rejected(self, isolated_config, body):
        assert client.put("/api/config", json=body).status_code == 422

    def test_bins_done_is_stored(self, tmp_path, monkeypatch):
        from app import bins

        monkeypatch.setattr(bins, "_state_path", lambda: tmp_path / "bins.json")
        body = client.post("/api/reminders/bins/done", json={"pickupDate": "2026-11-12"}).json()
        assert bins.load_done_for().isoformat() == "2026-11-12"
        assert "pickupDate" in body["bins"]

    def test_notification_targets_list_phones_first(self):
        class _Services(FakeClient):
            async def services(self):
                return [{"domain": "notify", "services": {"persistent_notification": {}, "family": {}, "mobile_app_pixel": {}}},
                        {"domain": "light", "services": {"turn_on": {}}}]

        app.dependency_overrides[get_client] = _Services
        try:
            assert client.get("/api/notifications/targets").json() == {"targets": ["notify.mobile_app_pixel", "notify.family"]}
        finally:
            app.dependency_overrides[get_client] = FakeClient

    def test_test_notification_needs_a_target(self, isolated_config):
        assert client.post("/api/notifications/test", json={"targets": []}).status_code == 400


class _SecureClient(FakeClient):
    calls: list = []

    async def states(self):
        return [{"entity_id": "lock.front_door", "state": "unlocked", "attributes": {"friendly_name": "Front Door"}},
                {"entity_id": "lock.volvo_xc60_lock", "state": "unlocked", "attributes": {"friendly_name": "Volvo XC60 Lock"}},
                {"entity_id": "light.kitchen", "state": "on", "attributes": {}},
                {"entity_id": "todo.shopping_list", "state": "0", "attributes": {}}]

    async def call_service(self, domain, service, data):
        _SecureClient.calls.append((domain, service, data))
        return []


class TestSecureHouseAndShopping:
    def setup_method(self):
        _SecureClient.calls = []
        app.dependency_overrides[get_client] = _SecureClient

    def teardown_method(self):
        app.dependency_overrides[get_client] = FakeClient

    def test_secure_house_needs_confirmation_and_never_touches_the_car(self):
        assert client.post("/api/actions/secure-house", json={}).status_code == 400
        body = client.post("/api/actions/secure-house", json={"confirm": True}).json()
        assert sorted(body["secured"]) == ["light.kitchen", "lock.front_door"]
        assert ("lock", "lock", {"entity_id": ["lock.front_door"]}) in _SecureClient.calls

    def test_adds_one_item_to_the_shopping_list(self):
        body = client.post("/api/actions/shopping-list", json={"item": "Dyson Carbon Filter"}).json()
        assert body == {"status": "added", "list": "todo.shopping_list", "item": "Dyson Carbon Filter"}
        assert _SecureClient.calls == [("todo", "add_item", {"entity_id": "todo.shopping_list", "item": "Dyson Carbon Filter"})]


def test_fixed_monthly_charge_defaults_to_the_tariff_and_saves(isolated_config, monkeypatch):
    # The add-on entrypoint test leaves ENERGY_RATE_PER_KWH set in the process environment.
    monkeypatch.delenv("ENERGY_RATE_PER_KWH", raising=False)
    monkeypatch.delenv("ENERGY_FIXED_MONTHLY", raising=False)
    config = client.get("/api/config").json()
    assert config["energyRatePerKwh"] == 0.109134
    assert config["energyFixedMonthly"] == 32.5
    assert client.put("/api/config", json={"energyFixedMonthly": 30}).json()["energyFixedMonthly"] == 30
    assert client.put("/api/config", json={"energyFixedMonthly": -1}).status_code == 422


def test_history_asks_for_the_whole_window():
    """Without an end_time Home Assistant returns only the first day after the start."""
    import asyncio as _asyncio

    from app.ha_client import HomeAssistantClient
    from app.config import Settings

    seen = {}

    class _Recorder:
        async def get(self, path, params=None):
            seen["params"] = params

            class _Response:
                def raise_for_status(self):
                    return None

                def json(self):
                    return []
            return _Response()

    ha = HomeAssistantClient(Settings(ha_url="http://ha", ha_token="t", cors_origins=()))
    ha.client = _Recorder()
    _asyncio.run(ha.history_many(["sensor.x"], hours=720))
    assert "end_time" in seen["params"]


class TestGuestWifi:
    def test_the_password_is_stored_but_never_in_the_config_response(self, isolated_config):
        saved = client.put("/api/config", json={"guestWifi": {"ssid": "HomeNet", "security": "WPA", "password": "correct horse"}}).json()
        assert saved["guestWifi"] == {"ssid": "HomeNet", "security": "WPA", "hidden": False, "hasPassword": True}
        assert "correct horse" not in client.get("/api/config").text
        response = client.get("/api/wifi")
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {"configured": True, "ssid": "HomeNet", "password": "correct horse", "security": "WPA", "hidden": False}

    def test_editing_without_a_password_keeps_the_old_one(self, isolated_config):
        client.put("/api/config", json={"guestWifi": {"ssid": "HomeNet", "password": "correct horse"}})
        client.put("/api/config", json={"guestWifi": {"ssid": "HomeNet-guest", "hidden": True}})
        body = client.get("/api/wifi").json()
        assert (body["ssid"], body["password"], body["hidden"]) == ("HomeNet-guest", "correct horse", True)

    def test_an_open_network_has_no_password_and_a_new_one_needs_one(self, isolated_config):
        assert client.put("/api/config", json={"guestWifi": {"ssid": "HomeNet"}}).status_code == 422
        client.put("/api/config", json={"guestWifi": {"ssid": "cafe", "security": "nopass"}})
        assert client.get("/api/wifi").json()["password"] == ""

    def test_validation(self, isolated_config):
        assert client.put("/api/config", json={"guestWifi": {"ssid": "HomeNet", "password": "short"}}).status_code == 422
        assert client.put("/api/config", json={"guestWifi": {"ssid": "x" * 33, "password": "long enough"}}).status_code == 422
        assert client.put("/api/config", json={"guestWifi": {"ssid": "", "password": "long enough"}}).status_code == 422

    def test_unconfigured(self, isolated_config):
        assert client.get("/api/wifi").json() == {"configured": False}
        assert client.get("/api/config").json()["guestWifi"] is None


class _PatioClient(FakeClient):
    """A re-paired door sensor leaves an unavailable twin; the working one has the history."""

    async def states(self):
        return [
            {"entity_id": "binary_sensor.patio_door_door", "state": "unavailable", "last_changed": "2026-11-11T05:17:00+00:00",
             "attributes": {"friendly_name": "Patio Door Door", "device_class": "door"}},
            {"entity_id": "binary_sensor.living_room_patio_door_door", "state": "off", "last_changed": "2026-11-11T05:17:00+00:00",
             "attributes": {"friendly_name": "Patio Door Door", "device_class": "door"}},
        ]

    async def history(self, entity_id, hours=24):
        self.asked = entity_id
        return [[]]


def test_the_routine_reads_the_live_patio_sensor_not_its_dead_twin():
    import asyncio as _asyncio

    from app import main as app_main, slow_cache

    slow_cache.clear()
    fake = _PatioClient()
    report = _asyncio.run(app_main.routine_report_now(fake, await_states(fake)))
    assert fake.asked == "binary_sensor.living_room_patio_door_door"
    assert report["label"] == "Patio Door" and report["routines"] == []
    slow_cache.clear()


def await_states(fake):
    import asyncio as _asyncio

    return _asyncio.run(fake.states())
