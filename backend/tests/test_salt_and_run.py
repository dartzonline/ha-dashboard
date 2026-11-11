import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

from app import morning_run, salt_watch
from tests.test_house_watch import BASE, HOUR, MINUTE, row

DAY = 86400.0
ZONE = ZoneInfo("America/Chicago")


class TestSaltWatch:
    def test_notices_a_refill_and_forecasts_the_low_point(self, tmp_path):
        watch = salt_watch.SaltWatch(tmp_path / "salt.json")
        level = 30.0
        for step in range(12):
            watch.record(level, BASE + step * DAY)
            level -= 1.0
        assert watch.record(80.0, BASE + 12 * DAY) is True
        for step in range(1, 9):
            watch.record(80.0 - 2.0 * step, BASE + (12 + step) * DAY)
        forecast = watch.forecast(BASE + 20 * DAY)
        assert forecast["refilledTo"] == 80.0
        assert forecast["perDay"] == 2.0
        assert forecast["daysToLow"] == 22.0
        reloaded = salt_watch.SaltWatch(tmp_path / "salt.json")
        assert len(reloaded.refills) == 1

    def test_samples_at_most_every_six_hours(self):
        watch = salt_watch.SaltWatch()
        watch.record(50.0, BASE)
        watch.record(49.9, BASE + HOUR)
        assert len(watch.samples) == 1

    def test_not_enough_history_means_no_forecast(self):
        watch = salt_watch.SaltWatch()
        watch.record(50.0, BASE)
        assert watch.forecast(BASE)["daysToLow"] is None


def local(day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 11, day, hour, minute, tzinfo=ZONE)


GARAGE_CLOSED = row("cover.garage_door", "closed", changed_ago=HOUR)
GARAGE_OPEN = row("cover.garage_door", "open", changed_ago=MINUTE)


class TestMorningRun:
    def test_before_leaving_checks_the_car_and_weather(self):
        run = morning_run.MorningRun()
        settings = morning_run.RunSettings()
        when = local(11, 8, 0)  # a Wednesday
        states = [GARAGE_CLOSED, row("lock.volvo_xc60_lock", "unlocked", name="Volvo XC60 Lock"),
                  row("weather.forecast_home", "rainy", temperature=45, temperature_unit="°F")]
        run.observe(states, when.timestamp(), when, settings)
        status = run.status(states, when.timestamp(), when, settings)
        assert status["phase"] == "before"
        labels = [check["label"] for check in status["checks"]]
        assert "Raining: take an umbrella" in labels and "Car unlocked" in labels
        assert any(label.startswith("Jacket weather") for label in labels)

    def test_garage_opening_is_the_departure_then_the_return(self):
        run = morning_run.MorningRun()
        settings = morning_run.RunSettings()
        leave, back = local(11, 8, 15), local(11, 9, 10)
        run.observe([GARAGE_CLOSED], leave.timestamp() - 60, leave, settings)
        run.observe([GARAGE_OPEN], leave.timestamp(), leave, settings)
        out_states = [GARAGE_CLOSED, row("lock.patio_door", "unlocked", name="Patio Door"), row("light.kitchen", "on", name="Kitchen")]
        run.observe(out_states, leave.timestamp() + 120, leave, settings)
        status = run.status(out_states, leave.timestamp() + 600, leave, settings)
        assert status["phase"] == "out"
        assert [item["label"] for item in status["leftBehind"]] == ["Patio Door unlocked", "Kitchen on"]
        run.observe([GARAGE_OPEN], back.timestamp(), back, settings)
        assert run.status([GARAGE_OPEN], back.timestamp(), back, settings)["phase"] == "back"

    def test_weekends_and_disabled_have_no_run(self):
        run = morning_run.MorningRun()
        saturday = local(14, 8, 15)
        assert run.status([GARAGE_CLOSED], saturday.timestamp(), saturday, morning_run.RunSettings())["phase"] is None
        wednesday = local(11, 8, 15)
        assert run.status([GARAGE_CLOSED], wednesday.timestamp(), wednesday, morning_run.RunSettings(enabled=False))["phase"] is None

    def test_vacuum_starts_once_after_the_house_is_still(self):
        calls = []

        async def call(domain, service, data):
            calls.append((domain, service, data["entity_id"]))

        run = morning_run.MorningRun()
        settings = morning_run.RunSettings(vacuum=True)
        leave = local(11, 8, 15)
        run.observe([GARAGE_CLOSED], leave.timestamp() - 60, leave, settings)
        run.observe([GARAGE_OPEN], leave.timestamp(), leave, settings)
        vacuum = {"entity_id": "vacuum.roborock", "state": "docked", "attributes": {}}
        stirring = {"entity_id": "binary_sensor.main_floor_motion", "state": "on", "last_changed": "2026-11-11T14:16:00+00:00", "attributes": {"device_class": "motion"}}
        assert asyncio.run(run.maybe_vacuum([vacuum, stirring], leave.timestamp() + 15 * 60, settings, call)) is False
        still = {**stirring, "state": "off", "last_changed": datetime.fromtimestamp(leave.timestamp() + 60, ZONE).isoformat()}
        assert asyncio.run(run.maybe_vacuum([vacuum, still], leave.timestamp() + 15 * 60, settings, call)) is True
        assert asyncio.run(run.maybe_vacuum([vacuum, still], leave.timestamp() + 20 * 60, settings, call)) is False
        assert calls == [("vacuum", "start", "vacuum.roborock")]

    def test_left_behind_skips_the_car_and_the_toddler_clock(self):
        items, actions = morning_run.left_behind([
            row("lock.volvo_xc60_lock", "unlocked", name="Volvo XC60 Lock"),
            row("media_player.my_rest_media_player", "playing", name="My Rest Media Player"),
            row("light.landscape_lights", "on", name="landscape lights"),
            row("lock.front_door", "unlocked", name="Front Door"),
        ])
        assert [item["label"] for item in items] == ["Front Door unlocked"]
        assert actions == [("lock", "lock", "lock.front_door")]
