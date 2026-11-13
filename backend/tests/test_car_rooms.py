"""Car charging and electric share, room balance, the garage light and the plug-in reminder."""

import asyncio
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from app import car_energy, house_watch, notifier, room_balance

ZONE = ZoneInfo("America/Chicago")


def epoch(day: int, hour: int, minute: int = 0) -> float:
    return datetime(2026, 11, day, hour, minute, tzinfo=ZONE).timestamp()


def iso(stamp: float) -> str:
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat()


# --- car ---------------------------------------------------------------------


def charge(day: int, hour: int, start: int, end: int, step_minutes: int = 9) -> list[tuple[float, str]]:
    return [(epoch(day, hour) + i * step_minutes * 60, str(float(level))) for i, level in enumerate(range(start, end + 1))]


class TestCarEnergy:
    def series(self):
        battery = [(epoch(10, 7), "100.0"), (epoch(10, 9), "60.0"), (epoch(10, 9, 30), "unavailable"), (epoch(10, 10), "62.0"),
                   (epoch(10, 18), "20.0")] + charge(10, 20, 20, 100)
        connection = [(epoch(10, 7), "connected"), (epoch(10, 8), "disconnected"), (epoch(10, 19, 59), "connected")]
        odometer = [(epoch(10, 7), "1000.0"), (epoch(10, 19), "1040.0")]
        fuel = [(epoch(10, 7), "18.0"), (epoch(10, 18), "17.5"), (epoch(10, 19), "unavailable"), (epoch(10, 19, 5), "17.5")]
        range_points = [(epoch(10, 7), "36.0"), (epoch(10, 18), "7.0")]
        return {"battery": battery, "connection": connection, "odometer": odometer, "fuel": fuel, "range": range_points}

    def test_charging_counts_only_plugged_in_rises_and_prices_them(self):
        week = car_energy.car_week(self.series(), 18.8, 0.10, ZONE, epoch(11, 9))
        # The 60 -> 62 bump came unplugged (regenerative braking), so one session: 20 -> 100.
        assert week["charges"] == 1
        session = week["sessions"][0]
        assert (session["fromPct"], session["toPct"]) == (20.0, 100.0)
        expected = 80 * 18.8 * car_energy.USABLE_FRACTION / 100 / car_energy.CHARGER_EFFICIENCY
        assert week["kwh"] == round(expected, 1)
        assert week["cost"] == round(round(expected, 1) * 0.10, 2)
        assert week["level1"] is True and week["typicalKw"] < 2

    def test_electric_share_from_battery_falls_and_the_odometer(self):
        week = car_energy.car_week(self.series(), 18.8, 0.10, ZONE, epoch(11, 9))
        # Unplugged falls: 100->60 and 62->20 = 82%, at 0.36 mi per % = 29.5 mi of 40.
        assert week["miles"] == 40.0
        assert week["electricMiles"] == 29.5
        assert week["electricShare"] == 0.74
        assert week["gallons"] == 0.5
        assert week["gasMpg"] == round((40 - 29.52) / 0.5, 1)

    def test_no_capacity_means_no_energy_estimate(self):
        week = car_energy.car_week(self.series(), None, 0.10, ZONE, epoch(11, 9))
        assert week["charges"] == 0 and week["fullChargeCost"] is None

    def test_a_pause_in_charging_longer_than_the_gap_starts_a_new_session(self):
        battery = charge(10, 1, 10, 20) + charge(10, 9, 20, 30)
        sessions = car_energy.charging_sessions(battery, [(epoch(10, 0), "connected")], 18.8)
        assert len(sessions) == 2


# --- rooms -------------------------------------------------------------------


def flat(value: float, start: float, hours: int, wobble: float = 0.2) -> list[tuple[float, str]]:
    return [(start + h * 3600, str(value + (wobble if h % 2 else 0))) for h in range(hours)]


def sensor(entity_id: str, name: str, state: str = "70") -> dict:
    return {"entity_id": entity_id, "state": state, "attributes": {"friendly_name": name, "device_class": "temperature", "unit_of_measurement": "°F"}}


class TestRoomBalance:
    def test_picks_rooms_and_the_thermostat_and_leaves_out_outdoor_and_plants(self):
        states = [
            sensor("sensor.hall_thermostat_temperature", "Hall Thermostat Temperature"),
            sensor("sensor.office_temperature", "Office Temperature"),
            sensor("sensor.open_weather_temperature", "Open Weather Temperature"),
            sensor("sensor.attic_sensor_temperature", "Attic sensor Temperature"),
            sensor("sensor.lawn_plant_sensor_temperature", "Plant sensor Temperature"),
            sensor("sensor.gone_temperature", "Gone", "unavailable"),
        ]
        rooms, reference = room_balance.room_sensors(states)
        assert [room["entity_id"] for room in rooms] == ["sensor.office_temperature"]
        assert reference["entity_id"] == "sensor.hall_thermostat_temperature"

    def test_labels(self):
        assert room_balance.clean_label("Master Bedroom Temperature Temperature") == "Master Bedroom"
        assert room_balance.clean_label("Media Sensor Temperature") == "Media"
        assert room_balance.clean_label("Den Den") == "Den"

    def test_cold_mornings_warm_rooms_and_frozen_sensors(self):
        start = epoch(4, 0)
        now = epoch(11, 0)
        hours = 7 * 24
        reference = flat(71.0, start, hours)
        # Cold only from midnight to noon.
        media = [(start + h * 3600, str(64.5 if datetime.fromtimestamp(start + h * 3600, ZONE).hour < 12 else 70.5 + (0.1 if h % 2 else 0)))
                 for h in range(hours)]
        office = flat(74.0, start, hours)
        guest = [(start, "76.3")]
        nursery = flat(71.5, start, hours)
        series = {"sensor.t": reference, "sensor.media": media, "sensor.office": office, "sensor.guest": guest, "sensor.nursery": nursery}
        states = {key: sensor(key, name) for key, name in [
            ("sensor.t", "Hall Thermostat"), ("sensor.media", "Media Sensor Temperature"), ("sensor.office", "Office Temperature"),
            ("sensor.guest", "Guest Temperature"), ("sensor.nursery", "Nursery Temperature")]}
        report = room_balance.room_balance(series, states, "sensor.t", ZONE, now, 7, "°F", "cool")
        rooms = {room["label"]: room for room in report["rooms"]}
        assert rooms["Media"]["status"] == "cool" and rooms["Media"]["worstPart"] in ("night", "morning")
        assert "vent" in rooms["Media"]["advice"]
        assert rooms["Office"]["status"] == "warm"
        assert "cool air" in rooms["Office"]["advice"]
        assert rooms["Guest"]["status"] == "stale" and "battery" in rooms["Guest"]["advice"]
        assert rooms["Nursery"]["status"] == "balanced"
        assert report["rooms"][-1]["status"] == "balanced"
        assert report["reference"]["label"] == "Hall Thermostat"

    def test_without_a_thermostat_sensor_the_house_median_is_the_reference(self):
        start, now = epoch(4, 0), epoch(11, 0)
        series = {"sensor.a": flat(70, start, 168), "sensor.b": flat(70.3, start, 168), "sensor.c": flat(76, start, 168)}
        states = {key: sensor(key, key) for key in series}
        report = room_balance.room_balance(series, states, None, ZONE, now, 7)
        assert report["reference"]["label"] == "House median"
        assert {room["entityId"]: room["status"] for room in report["rooms"]}["sensor.c"] == "warm"


# --- house watch ---------------------------------------------------------------


def entity(entity_id, state, changed, **attributes):
    return {"entity_id": entity_id, "state": state, "last_changed": iso(changed), "attributes": attributes}


class TestGarageLight:
    def states(self, light_on_at, door_closed_at, door_state="closed"):
        return [
            entity("light.garage_light", "on", light_on_at, friendly_name="Garrage Light"),
            entity("cover.garage_door", door_state, door_closed_at, device_class="garage", friendly_name="Garage Door"),
        ]

    def test_warns_after_15_minutes_with_the_door_shut_and_switches_off_at_an_hour(self):
        now = epoch(11, 20)
        states = self.states(now - 3 * 3600, now - 20 * 60)
        found = [item for item in house_watch.findings(states, now) if item.entity_id == "light.garage_light"]
        assert found[0].rule == "garage_light_on" and "20m" in found[0].detail
        assert house_watch.due_actions(states, now) == []
        later = now + 41 * 60
        assert house_watch.due_actions(states, later) == [("light", "turn_off", "light.garage_light")]

    def test_quiet_while_the_garage_is_open_or_just_closed(self):
        now = epoch(11, 20)
        assert not [i for i in house_watch.findings(self.states(now - 3600, now - 600), now) if i.rule == "garage_light_on"]
        assert not [i for i in house_watch.findings(self.states(now - 3600, now - 3600, "open"), now) if i.rule == "garage_light_on"]

    def test_offered_on_the_health_page_switch_off(self):
        now = epoch(11, 20)
        assert ("light", "turn_off", "light.garage_light") in house_watch.switch_off_targets(self.states(now - 3600, now - 1800), now)


class TestCarPlugIn:
    def states(self, level="18.0", plugged="disconnected", parked_for=3600, dark_for=3600, in_use="available"):
        now = epoch(11, 21)
        return now, [
            entity("sensor.volvo_xc60_battery", level, now - parked_for, device_class="battery", friendly_name="Volvo XC60 Battery"),
            entity("sensor.volvo_xc60_charging_connection_status", plugged, now - parked_for),
            entity("sensor.volvo_xc60_car_connection", in_use, now - parked_for),
            entity("sun.sun", "below_horizon", now - dark_for),
        ]

    def rule(self, now, states):
        return [item for item in house_watch.findings(states, now) if item.rule == "car_needs_plug"]

    def test_low_unplugged_and_parked_after_dark(self):
        now, states = self.states()
        found = self.rule(now, states)
        assert found and found[0].severity == "info" and found[0].detail == "Battery at 18% and not plugged in"

    def test_quiet_when_plugged_charged_driving_or_still_daylight(self):
        for kwargs in ({"plugged": "connected"}, {"level": "55.0"}, {"in_use": "car_in_use"}, {"parked_for": 600}, {"dark_for": 600}):
            now, states = self.states(**kwargs)
            assert self.rule(now, states) == [], kwargs

    def test_one_phone_reminder_an_evening(self):
        class Journal:
            def report_journal(self):
                return [{"rule": "car_needs_plug", "entityId": "sensor.volvo_xc60_battery", "endedAt": None, "severity": "info",
                         "name": "Plug in the car", "detail": "Battery at 18% and not plugged in", "startedAt": 0.0}]

        sent = []

        async def states():
            return []

        async def call_service(domain, service, data):
            sent.append(data)

        async def zone():
            return ZONE

        notes = notifier.Notifier(notifier.Sources(
            get_states=states, call_service=call_service, get_zone=zone,
            get_overrides=lambda: {"notifications": {"targets": ["notify.mobile_app_x"], "bins": False, "forecast": False, "weekly": False}},
            watcher=Journal(),
        ))
        assert asyncio.run(notes.check_once(epoch(11, 20))) == ["plug:2026-11-11"]
        assert asyncio.run(notes.check_once(epoch(11, 20, 30))) == []
        assert sent[0]["title"] == "Plug in the car"
