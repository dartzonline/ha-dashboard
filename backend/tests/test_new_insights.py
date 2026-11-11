"""Routines, flaky devices, opener health, backup status and air quality."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from app import air_quality, flaky, garage_health, home_health, routines

ZONE = ZoneInfo("America/Chicago")
NOW = datetime(2026, 11, 11, 21, 0, tzinfo=ZONE)


def epoch(day: int, hour: int, minute: int = 0, second: int = 0) -> float:
    return datetime(2026, 11, day, hour, minute, second, tzinfo=ZONE).timestamp()


def door_points(days: range, times: list[tuple[int, int]], stay_minutes: int = 6) -> list[tuple[float, str]]:
    points: list[tuple[float, str]] = [(epoch(days.start, 0), "off")]
    for day in days:
        for hour, minute in times:
            start = epoch(day, hour, minute)
            points += [(start, "on"), (start + 60, "off"), (start + stay_minutes * 60 - 30, "on"), (start + stay_minutes * 60, "off")]
    return points


class TestRoutines:
    def test_learns_three_daily_visits_and_merges_the_in_and_out(self):
        points = door_points(range(1, 11), [(7, 2), (16, 5), (22, 1)])
        report = routines.routine_report(points, ZONE, NOW.timestamp())
        assert [item["time"] for item in report["routines"]] == ["7:02 am", "4:05 pm", "10:01 pm"]
        assert report["routines"][0]["typicalMinutes"] == 6
        assert report["routines"][0]["daysSeen"] == 10

    def test_today_done_expected_and_late(self):
        base = door_points(range(1, 11), [(7, 2), (16, 5), (22, 1)])
        today = base + [(epoch(11, 7, 10), "on"), (epoch(11, 7, 16), "off")]
        evening = datetime(2026, 11, 11, 22, 45, tzinfo=ZONE)
        report = routines.routine_report(today, ZONE, evening.timestamp())["routines"]
        by_time = {item["time"]: item for item in report}
        assert by_time["7:02 am"]["status"] == "done" and by_time["7:02 am"]["at"] == "7:10 am"
        assert by_time["4:05 pm"]["status"] == "late"
        assert by_time["10:01 pm"]["status"] == "late"
        midday = datetime(2026, 11, 11, 15, 50, tzinfo=ZONE)
        statuses = {item["time"]: item["status"] for item in routines.routine_report(today, ZONE, midday.timestamp())["routines"]}
        assert statuses == {"7:02 am": "done", "4:05 pm": "expected", "10:01 pm": "upcoming"}

    def test_a_visit_a_little_late_still_counts_and_a_few_days_is_not_a_routine(self):
        points = door_points(range(1, 11), [(22, 1)]) + [(epoch(11, 22, 40), "on"), (epoch(11, 22, 45), "off")]
        status = routines.routine_report(points, ZONE, datetime(2026, 11, 11, 23, 0, tzinfo=ZONE).timestamp())["routines"][0]
        assert status["status"] == "done"
        assert routines.routine_report(door_points(range(8, 11), [(7, 0)]), ZONE, NOW.timestamp())["routines"] == []

    def test_occasional_openings_are_not_a_routine(self):
        points = door_points(range(1, 11), [(7, 2)]) + door_points(range(2, 11, 4), [(13, 30)])
        assert [item["time"] for item in routines.routine_report(points, ZONE, NOW.timestamp())["routines"]] == ["7:02 am"]


def tracker_rows(entity_id: str, flips: list[float]) -> list[dict]:
    rows = [{"entity_id": entity_id, "state": "home", "last_changed": datetime.fromtimestamp(flips[0] - 600, ZONE).isoformat()}]
    for moment in flips:
        rows.append({"state": "not_home", "last_changed": datetime.fromtimestamp(moment, ZONE).isoformat()})
        rows.append({"state": "home", "last_changed": datetime.fromtimestamp(moment + 60, ZONE).isoformat()})
    return rows


class TestFlaky:
    def test_counts_wifi_drops_and_ignores_a_restart_moment(self):
        chatty = [epoch(day, hour, 10) for day in range(5, 11) for hour in (1, 5, 9, 13, 17)]
        restart = epoch(9, 23, 15)
        series = [tracker_rows("device_tracker.sensor_node", chatty + [restart]), tracker_rows("device_tracker.quiet", [restart])]
        series += [tracker_rows(f"device_tracker.other{n}", [restart]) for n in range(9)]
        states = {"device_tracker.sensor_node": {"entity_id": "device_tracker.sensor_node", "state": "home",
                  "attributes": {"friendly_name": "sensor-node", "ip": "192.168.1.50", "mac": "aa:bb:cc:dd:ee:ff"}}}
        [device] = flaky.flaky_devices(series, states, ZONE, NOW.timestamp(), 7)
        assert device["dropouts"] == 30
        assert device["ip"] == "192.168.1.50" and device["kind"] == "wifi"

    def test_a_projector_that_goes_unavailable_every_night_has_a_usual_hour(self):
        rows = [{"entity_id": "media_player.projector", "state": "off", "last_changed": datetime(2026, 11, 3, 12, tzinfo=ZONE).isoformat()}]
        for day in range(4, 11):
            rows.append({"state": "unavailable", "last_changed": datetime(2026, 11, day, 3, 40, tzinfo=ZONE).isoformat()})
            rows.append({"state": "off", "last_changed": datetime(2026, 11, day, 3, 41, tzinfo=ZONE).isoformat()})
        rows += [
            {"state": "unavailable", "last_changed": datetime(2026, 11, 10, 14, tzinfo=ZONE).isoformat()},
            {"state": "off", "last_changed": datetime(2026, 11, 10, 14, 1, tzinfo=ZONE).isoformat()},
        ] * 0
        # six drops is the floor for being called flaky
        rows += [{"state": "unavailable", "last_changed": datetime(2026, 11, 2, 3, 40, tzinfo=ZONE).isoformat()}]
        [device] = flaky.flaky_devices([rows], {}, ZONE, NOW.timestamp(), 7)
        assert device["dropouts"] == 8 and device["usualHour"] == 3

    def test_only_relevant_entities_are_watched(self):
        assert flaky.watched({"entity_id": "device_tracker.x", "attributes": {}})
        assert flaky.watched({"entity_id": "binary_sensor.wan", "attributes": {"device_class": "connectivity"}})
        assert not flaky.watched({"entity_id": "sensor.temperature", "attributes": {}})
        assert not flaky.watched({"entity_id": "binary_sensor.door", "attributes": {"device_class": "door"}})


def cover_rows(spec: list[tuple[float, str]]) -> list[dict]:
    return [{"entity_id": "cover.garage", "state": state, "last_changed": datetime.fromtimestamp(moment, ZONE).isoformat()} for moment, state in spec]


class TestOpenerHealth:
    def test_measures_travel_and_spots_a_slowing_door(self):
        spec: list[tuple[float, str]] = []
        for day in range(1, 5):  # earlier week: 12 s to open, twice a day
            for hour in (8, 17):
                start = epoch(day, hour)
                spec += [(start, "opening"), (start + 12, "open"), (start + 300, "closing"), (start + 311, "closed")]
        for day in range(8, 11):  # this week: 16 s to open
            start = epoch(day, 8)
            spec += [(start, "opening"), (start + 16, "open"), (start + 300, "closing"), (start + 311, "closed")]
        for day in range(9, 11):
            start = epoch(day, 17)
            spec += [(start, "opening"), (start + 16, "open"), (start + 300, "closing"), (start + 311, "closed")]
        health = garage_health.opener_health(cover_rows(spec), epoch(11, 9))
        assert health["opening"]["seconds"] == 16.0 and health["opening"]["previous"] == 12.0
        assert health["opening"]["slowing"] is True
        assert health["closing"]["slowing"] is False
        assert health["trips"] == 6  # includes the 17:00 trip on the 4th

    def test_counts_reversals_and_needs_enough_samples(self):
        spec = [(epoch(10, 8), "closing"), (epoch(10, 8, 0, 4), "opening"), (epoch(10, 8, 0, 14), "open")]
        health = garage_health.opener_health(cover_rows(spec), epoch(11, 9))
        assert health["reversals"] == 1
        assert health["opening"] is None


def entity(entity_id: str, state: str, **attributes) -> dict:
    return {"entity_id": entity_id, "state": state, "attributes": attributes, "last_changed": "2026-11-10T12:00:00+00:00"}


class TestBackupStatus:
    def test_failing_for_months_is_critical(self):
        states = [
            entity("sensor.backup_last_successful_automatic_backup", "2026-05-24T10:28:33+00:00"),
            entity("sensor.backup_last_attempted_automatic_backup", "2026-11-10T11:03:09+00:00"),
            entity("sensor.backup_next_scheduled_automatic_backup", "2026-11-11T11:02:32+00:00"),
            entity("event.backup_automatic_backup", "2026-11-10T11:03:22+00:00", event_type="failed"),
        ]
        status = home_health.backup_status(states, now=datetime(2026, 11, 10, 18, tzinfo=ZONE).timestamp())
        assert status["severity"] == "critical" and status["failing"] is True
        assert round(status["daysSinceSuccess"]) == 171 and status["lastResult"] == "failed"

    def test_a_recent_success_is_ok_and_no_backups_is_none(self):
        states = [entity("sensor.backup_last_successful_automatic_backup", "2026-11-10T09:00:00+00:00")]
        assert home_health.backup_status(states, now=datetime(2026, 11, 10, 18, tzinfo=ZONE).timestamp())["severity"] == "ok"
        assert home_health.backup_status([], now=0) is None


def air_states(outdoor_aqi: float, pm25: float, *, purifier_on: bool = True, speed: int = 50, outdoor_f: float = 64.0, indoor_f: float = 72.0, weather: str = "sunny") -> list[dict]:
    return [
        entity("sensor.dyson_outdoor_aqi", str(outdoor_aqi), device_class="aqi", friendly_name="Dyson Outdoor AQI"),
        entity("sensor.dyson_pm2_5", str(pm25), device_class="pm25", friendly_name="Dyson PM2.5"),
        entity("fan.dyson", "on" if purifier_on else "off", friendly_name="Dyson", percentage=speed),
        entity("weather.forecast_home", weather, temperature=outdoor_f, temperature_unit="°F"),
        entity("climate.main", "cool", current_temperature=indoor_f),
    ]


class TestAirQuality:
    def advice(self, **kwargs):
        return {item.id: item for item in air_quality.air_advice(air_quality.snapshot(air_states(**kwargs)))}

    def test_smoky_outside_means_windows_shut_and_purifier_high(self):
        found = self.advice(outdoor_aqi=135, pm25=4)
        item = found["air-outdoor:today"]
        assert item.severity == "warning" and "AQI 135" in item.title
        assert "purifier on high" in item.detail and "clean" in item.detail

    def test_good_air_on_a_mild_day_suggests_opening_the_windows(self):
        assert "air-windows:today" in self.advice(outdoor_aqi=34, pm25=3)
        assert "air-windows:today" not in self.advice(outdoor_aqi=34, pm25=3, weather="rainy")
        assert "air-windows:today" not in self.advice(outdoor_aqi=34, pm25=3, outdoor_f=40.0)
        assert "air-windows:today" not in self.advice(outdoor_aqi=90, pm25=3)

    def test_bad_indoor_air_says_what_to_do_with_the_purifier(self):
        assert "turn it up" in self.advice(outdoor_aqi=40, pm25=41, speed=30)["air-indoor:today"].detail
        assert "turn it on" in self.advice(outdoor_aqi=40, pm25=41, purifier_on=False)["air-indoor:today"].detail
        assert self.advice(outdoor_aqi=40, pm25=60)["air-indoor:today"].severity == "critical"

    def test_no_air_sensors_means_no_advice(self):
        assert air_quality.snapshot([entity("sensor.temperature", "70")]) is None
        assert air_quality.air_advice(None) == []


def test_label_drops_the_repeated_entity_name():
    assert routines.clean_label("Patio Door Door") == "Patio Door"
    assert routines.clean_label("Back Door") == "Back Door"
    assert routines.clean_label("door door") == "door"
