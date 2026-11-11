"""House watch: things left running or left open, and how long for.

Mirrors the fixture style in test_home_health.py -- every test passes an
explicit `now=`, nothing depends on wall-clock time.
"""

import asyncio
from datetime import datetime, timezone

from app import house_watch

BASE = 1_700_000_000.0
MINUTE = 60.0
HOUR = 3600.0


def stamp(seconds_ago: float, now: float = BASE) -> str:
    return datetime.fromtimestamp(now - seconds_ago, timezone.utc).isoformat().replace("+00:00", "Z")


def row(entity_id: str, state, *, changed_ago: float = 60.0, device_class: str | None = None, name: str | None = None, **attributes) -> dict:
    attrs: dict = dict(attributes)
    if device_class is not None:
        attrs["device_class"] = device_class
    if name is not None:
        attrs["friendly_name"] = name
    return {"entity_id": entity_id, "state": str(state), "last_changed": stamp(changed_ago), "attributes": attrs}


class TestLightLeftOn:
    def test_under_warn_threshold_is_silent(self):
        states = [row("light.kitchen", "on", changed_ago=30 * MINUTE)]
        assert house_watch.findings(states, BASE) == []

    def test_warns_after_two_hours_without_acting_yet(self):
        states = [row("light.kitchen", "on", changed_ago=2.5 * HOUR)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "light_left_on"
        assert finding.category == "light"
        assert "switches off at 4h" in finding.detail
        assert house_watch.due_actions(states, BASE) == []

    def test_switches_off_at_four_hours(self):
        states = [row("light.kitchen", "on", changed_ago=4.5 * HOUR)]
        [finding] = house_watch.findings(states, BASE)
        assert "switching off now" in finding.detail
        assert house_watch.due_actions(states, BASE) == [("light", "turn_off", "light.kitchen")]

    def test_landscape_lighting_is_exempt(self):
        states = [row("light.landscape_path", "on", changed_ago=10 * HOUR, name="Landscape path lights")]
        assert house_watch.findings(states, BASE) == []

    def test_nursery_clock_is_exempt_and_never_switched_off(self):
        states = [row("light.my_rest_clock", "on", changed_ago=10 * HOUR, name="Nursery clock")]
        assert house_watch.findings(states, BASE) == []
        assert house_watch.due_actions(states, BASE) == []

    def test_the_excluded_list_is_the_household_s_to_change(self):
        states = [row("light.my_rest_clock", "on", changed_ago=10 * HOUR), row("light.kitchen", "on", changed_ago=10 * HOUR)]
        custom = house_watch.WatchSettings(light_excluded_ids=frozenset({"light.kitchen"}))
        assert [f.entity_id for f in house_watch.findings(states, BASE, custom)] == ["light.my_rest_clock"]
        assert house_watch.due_actions(states, BASE, custom) == [("light", "turn_off", "light.my_rest_clock")]

    def test_the_switch_off_time_follows_the_setting(self):
        states = [row("light.kitchen", "on", changed_ago=40 * MINUTE)]
        assert house_watch.due_actions(states, BASE) == []
        custom = house_watch.WatchSettings(light_auto_off_s=30 * MINUTE)
        assert house_watch.due_actions(states, BASE, custom) == [("light", "turn_off", "light.kitchen")]

    def test_a_short_limit_warns_halfway_and_names_the_limit(self):
        custom = house_watch.WatchSettings(light_auto_off_s=30 * MINUTE)
        states = [row("light.kitchen", "on", changed_ago=20 * MINUTE)]
        [finding] = house_watch.findings(states, BASE, custom)
        assert "switches off at 30m" in finding.detail
        assert house_watch.findings([row("light.kitchen", "on", changed_ago=10 * MINUTE)], BASE, custom) == []

    def test_applied_settings_drive_the_background_loop(self):
        calls = []

        async def call_service(domain, service, data):
            calls.append((domain, service, data["entity_id"]))

        async def get_states():
            return [row("light.kitchen", "on", changed_ago=1 * HOUR)]

        house_watch.apply_settings(house_watch.WatchSettings(light_auto_off_s=45 * MINUTE))
        try:
            run(house_watch.HouseWatch(get_states, call_service).check_once(BASE))
        finally:
            house_watch.apply_settings(house_watch.WatchSettings())
        assert calls == [("light", "turn_off", {"entity_id": "light.kitchen"}["entity_id"])]

    def test_stored_overrides_fall_back_to_defaults_when_malformed(self):
        defaults = house_watch.settings_from_overrides({})
        assert defaults.light_auto_off_s == 4 * HOUR
        assert defaults.light_excluded_ids == frozenset({"light.my_rest_clock"})
        bad = house_watch.settings_from_overrides({"lightAutoOffMinutes": "soon", "lightAutoOffExcludedIds": "light.x"})
        assert bad == defaults
        empty = house_watch.settings_from_overrides({"lightAutoOffMinutes": 90, "lightAutoOffExcludedIds": []})
        assert empty.light_auto_off_s == 90 * MINUTE and empty.light_excluded_ids == frozenset()

    def test_light_group_is_skipped_members_judged_individually(self):
        group = row("light.living_room_group", "on", changed_ago=10 * HOUR)
        group["attributes"]["entity_id"] = ["light.lamp_1", "light.lamp_2"]
        member = row("light.lamp_1", "on", changed_ago=10 * HOUR)
        [finding] = house_watch.findings([group, member], BASE)
        assert finding.entity_id == "light.lamp_1"

    def test_off_light_is_ignored(self):
        states = [row("light.kitchen", "off", changed_ago=10 * HOUR)]
        assert house_watch.findings(states, BASE) == []


class TestIrrigation:
    def test_valve_shuts_off_at_two_hours(self):
        states = [row("valve.drip_zone_1", "open", changed_ago=2.5 * HOUR)]
        assert house_watch.due_actions(states, BASE) == [("valve", "close_valve", "valve.drip_zone_1")]

    def test_switch_warns_at_one_hour(self):
        states = [row("switch.sprinkler_pump", "on", changed_ago=70 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "irrigation_running"
        assert house_watch.due_actions(states, BASE) == []

    def test_unrelated_switch_is_not_irrigation(self):
        states = [row("switch.porch_fan", "on", changed_ago=5 * HOUR)]
        assert house_watch.findings(states, BASE) == []


class TestFridgeDoor:
    def test_critical_after_five_minutes(self):
        states = [row("binary_sensor.fridge_door", "on", changed_ago=6 * MINUTE, device_class="door")]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"
        assert finding.category == "fridge"

    def test_not_yet_critical(self):
        states = [row("binary_sensor.fridge_door", "on", changed_ago=2 * MINUTE, device_class="door")]
        assert house_watch.findings(states, BASE) == []


class TestGarage:
    def test_warns_at_thirty_minutes_then_critical_at_two_hours(self):
        states = [row("cover.garage_door", "open", changed_ago=40 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "warning"

        states = [row("cover.garage_door", "open", changed_ago=2.5 * HOUR)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"

    def test_garage_is_never_acted_on(self):
        states = [row("cover.garage_door", "open", changed_ago=10 * HOUR)]
        assert house_watch.due_actions(states, BASE) == []


class TestLockAndHvacAndAway:
    def test_lock_warns_after_thirty_minutes(self):
        states = [row("lock.front_door", "unlocked", changed_ago=31 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "lock_unlocked"
        assert house_watch.due_actions(states, BASE) == []

    def test_door_open_while_hvac_running(self):
        states = [
            row("climate.thermostat", "heat", hvac_action="heating"),
            row("binary_sensor.patio_door", "on", changed_ago=11 * MINUTE, device_class="door"),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "open_while_hvac"

    def test_no_warning_when_hvac_idle(self):
        states = [
            row("climate.thermostat", "off", hvac_action="idle"),
            row("binary_sensor.patio_door", "on", changed_ago=11 * MINUTE, device_class="door"),
        ]
        assert house_watch.findings(states, BASE) == []

    def test_light_left_on_while_everyone_away(self):
        states = [
            row("person.alex", "not_home", changed_ago=2 * HOUR),
            row("light.den", "on", changed_ago=40 * MINUTE),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "away_and_on"
        assert "away" in finding.detail

    def test_someone_home_suppresses_away_rule(self):
        states = [
            row("person.alex", "home", changed_ago=2 * HOUR),
            row("light.den", "on", changed_ago=40 * MINUTE),
        ]
        findings = house_watch.findings(states, BASE)
        assert all(item.rule != "away_and_on" for item in findings)


class TestFindingSelection:
    def test_one_finding_per_entity_prefers_higher_severity(self):
        # A door that is both "open while HVAC running" (warning) and, once it
        # doubles as a garage sensor, more severe -- the garage result should win.
        states = [row("binary_sensor.garage_door", "on", changed_ago=3 * HOUR, device_class="garage_door")]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"

    def test_dead_state_entities_are_skipped(self):
        states = [row("light.kitchen", "unavailable", changed_ago=10 * HOUR)]
        assert house_watch.findings(states, BASE) == []

    def test_missing_timestamp_is_left_alone(self):
        states = [{"entity_id": "light.kitchen", "state": "on", "last_changed": None, "attributes": {}}]
        assert house_watch.findings(states, BASE) == []

    def test_attention_items_shape_matches_home_health(self):
        states = [row("light.kitchen", "on", changed_ago=3 * HOUR)]
        [item] = house_watch.attention_items(states, BASE)
        assert set(item) == {"severity", "category", "title", "detail", "entityId"}


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=5))


class TestHouseWatchLoop:
    def test_check_once_acts_and_records_recent(self):
        states = [row("light.kitchen", "on", changed_ago=5 * HOUR)]
        calls: list[tuple[str, str, dict]] = []

        async def get_states():
            return states

        async def call_service(domain, service, data):
            calls.append((domain, service, data))

        async def scenario():
            watcher = house_watch.HouseWatch(get_states=get_states, call_service=call_service)
            acted = await watcher.check_once(BASE)
            assert acted == ["light.kitchen"]
            assert calls == [("light", "turn_off", {"entity_id": "light.kitchen"})]
            assert watcher.recent[0]["entityId"] == "light.kitchen"
            assert watcher.recent[0]["service"] == "light.turn_off"

        run(scenario())

    def test_failed_action_is_not_retried_immediately(self):
        states = [row("light.kitchen", "on", changed_ago=5 * HOUR)]

        async def get_states():
            return states

        async def call_service(domain, service, data):
            raise RuntimeError("bulb unreachable")

        async def scenario():
            watcher = house_watch.HouseWatch(get_states=get_states, call_service=call_service)
            first = await watcher.check_once(BASE)
            second = await watcher.check_once(BASE + 60.0)
            assert first == []
            assert second == []
            assert watcher.recent == []

        run(scenario())

    def test_retries_after_the_retry_window(self):
        states = [row("light.kitchen", "on", changed_ago=5 * HOUR)]
        attempts = 0

        async def get_states():
            return states

        async def call_service(domain, service, data):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("bulb unreachable")

        async def scenario():
            watcher = house_watch.HouseWatch(get_states=get_states, call_service=call_service)
            await watcher.check_once(BASE)
            acted = await watcher.check_once(BASE + house_watch.RETRY_AFTER_S + 1)
            assert acted == ["light.kitchen"]

        run(scenario())


class TestChristmasLights:
    def test_christmas_lights_are_never_flagged_or_switched_off(self):
        states = [
            row("light.christmas_tree", "on", changed_ago=9 * HOUR),
            row("light.porch_string", "on", changed_ago=9 * HOUR, name="Porch Xmas lights"),
        ]
        assert house_watch.findings(states, BASE) == []
        assert house_watch.due_actions(states, BASE) == []


class TestFrostWatering:
    def test_shuts_irrigation_off_at_once_when_freezing(self):
        states = [
            row("sensor.outdoor_temperature", "1.0", device_class="temperature", unit_of_measurement="°C"),
            row("valve.drip_zone_1", "open", changed_ago=3 * MINUTE),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "irrigation_frost"
        assert finding.severity == "critical"
        assert house_watch.due_actions(states, BASE) == [("valve", "close_valve", "valve.drip_zone_1")]

    def test_reads_the_weather_entity_in_fahrenheit_without_a_sensor(self):
        states = [
            row("weather.forecast_home", "sunny", temperature=30, temperature_unit="°F"),
            row("switch.sprinkler_front", "on", changed_ago=MINUTE),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "irrigation_frost"
        assert "-1°C" in finding.detail

    def test_mild_weather_leaves_short_watering_alone(self):
        states = [
            row("weather.forecast_home", "sunny", temperature=12, temperature_unit="°C"),
            row("valve.drip_zone_1", "open", changed_ago=10 * MINUTE),
        ]
        assert house_watch.findings(states, BASE) == []

    def test_no_temperature_means_no_frost_rule(self):
        states = [row("valve.drip_zone_1", "open", changed_ago=10 * MINUTE)]
        assert house_watch.findings(states, BASE) == []


class TestSpaceHeater:
    def test_warns_at_three_hours_and_escalates_at_six(self):
        [warning] = house_watch.findings([row("switch.office_space_heater", "on", changed_ago=3.5 * HOUR)], BASE)
        assert (warning.rule, warning.severity) == ("space_heater_on", "warning")
        [critical] = house_watch.findings([row("switch.office_space_heater", "on", changed_ago=7 * HOUR)], BASE)
        assert critical.severity == "critical"

    def test_never_acted_on_automatically(self):
        states = [row("switch.office_space_heater", "on", changed_ago=10 * HOUR)]
        assert house_watch.due_actions(states, BASE) == []

    def test_heater_on_while_everyone_is_away_is_critical_after_thirty_minutes(self):
        states = [
            row("person.alex", "not_home", changed_ago=2 * HOUR),
            row("switch.bedroom_heater", "on", changed_ago=45 * MINUTE),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"
        assert "away" in finding.detail

    def test_water_heater_is_not_a_space_heater(self):
        states = [row("switch.water_heater", "on", changed_ago=10 * HOUR)]
        assert house_watch.findings(states, BASE) == []


class TestSwitchOffTargets:
    def test_includes_things_left_running_but_never_doors_locks_or_garages(self):
        states = [
            row("light.kitchen", "on", changed_ago=3 * HOUR),
            row("switch.office_space_heater", "on", changed_ago=4 * HOUR),
            row("cover.garage_door", "open", changed_ago=3 * HOUR),
            row("lock.front_door", "unlocked", changed_ago=3 * HOUR),
            row("binary_sensor.fridge_door", "on", changed_ago=10 * MINUTE, device_class="door"),
        ]
        targets = house_watch.switch_off_targets(states, BASE)
        assert sorted(targets) == [("light", "turn_off", "light.kitchen"), ("switch", "turn_off", "switch.office_space_heater")]

    def test_media_left_playing_while_away_is_turned_off(self):
        states = [
            row("person.alex", "not_home", changed_ago=2 * HOUR),
            row("media_player.living_room", "playing", changed_ago=HOUR),
        ]
        assert house_watch.switch_off_targets(states, BASE) == [("media_player", "turn_off", "media_player.living_room")]


def sun(state: str, changed_ago: float) -> dict:
    return row("sun.sun", state, changed_ago=changed_ago)


class TestNightAndWeather:
    def test_window_open_after_dark_warns_thirty_minutes_after_sunset(self):
        states = [sun("below_horizon", HOUR), row("binary_sensor.bedroom_window", "on", changed_ago=5 * HOUR, device_class="window")]
        [finding] = house_watch.findings(states, BASE)
        assert (finding.rule, finding.category) == ("open_after_dark", "night")
        early = [sun("below_horizon", 10 * MINUTE), row("binary_sensor.bedroom_window", "on", changed_ago=5 * HOUR, device_class="window")]
        assert house_watch.findings(early, BASE) == []

    def test_garage_open_after_dark_is_critical_after_fifteen_minutes(self):
        states = [sun("below_horizon", HOUR), row("cover.garage_door", "open", changed_ago=20 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"
        assert "after dark" in finding.detail

    def test_lock_unlocked_at_night_is_critical(self):
        states = [sun("below_horizon", 2 * HOUR), row("lock.back_door", "unlocked", changed_ago=40 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.severity == "critical"

    def test_window_open_while_raining(self):
        states = [
            row("weather.forecast_home", "rainy"),
            row("binary_sensor.office_window", "on", changed_ago=10 * MINUTE, device_class="window"),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "window_in_rain"

    def test_door_open_while_everyone_is_away(self):
        states = [
            row("person.alex", "not_home", changed_ago=HOUR),
            row("binary_sensor.back_door", "on", changed_ago=3 * HOUR, device_class="door"),
        ]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "open_while_away"


class TestDaytimeAndAppliances:
    def test_porch_light_on_in_daylight_can_be_switched_off(self):
        # On since before sunrise, but not yet long enough for the ordinary "left on" rule.
        states = [sun("above_horizon", 80 * MINUTE), row("light.porch", "on", changed_ago=100 * MINUTE)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "outdoor_light_day"
        assert house_watch.switch_off_targets(states, BASE) == [("light", "turn_off", "light.porch")]
        # Offered for one-tap switch-off, never switched off on its own.
        assert house_watch.due_actions(states, BASE) == []

    def test_oven_on_too_long(self):
        [warning] = house_watch.findings([row("sensor.oven_status", "baking", changed_ago=70 * MINUTE)], BASE)
        assert (warning.rule, warning.severity) == ("oven_on", "warning")
        [critical] = house_watch.findings([row("switch.stove", "on", changed_ago=4 * HOUR)], BASE)
        assert critical.severity == "critical"

    def test_freezer_too_warm_is_critical_and_fridge_warm_is_a_warning(self):
        [freezer] = house_watch.findings([row("sensor.garage_freezer_temperature", "21", device_class="temperature", unit_of_measurement="°F")], BASE)
        assert freezer.severity == "critical"
        [fridge] = house_watch.findings([row("sensor.fridge_temperature", "10", device_class="temperature", unit_of_measurement="°C")], BASE)
        assert fridge.severity == "warning"
        assert house_watch.findings([row("sensor.fridge_temperature", "3", device_class="temperature", unit_of_measurement="°C")], BASE) == []

    def test_heating_an_empty_house(self):
        states = [
            row("person.alex", "not_home", changed_ago=3 * HOUR),
            row("climate.main", "heat", hvac_action="heating"),
        ]
        assert any(item.rule == "hvac_empty_house" for item in house_watch.findings(states, BASE))

    def test_laundry_waiting_then_forgotten(self):
        [finding] = house_watch.findings([row("sensor.washer_status", "complete", changed_ago=45 * MINUTE)], BASE)
        assert finding.severity == "info"
        assert house_watch.findings([row("sensor.washer_status", "complete", changed_ago=13 * HOUR)], BASE) == []

    def test_bath_fan_left_running(self):
        states = [row("fan.main_bath_exhaust", "on", changed_ago=2 * HOUR)]
        [finding] = house_watch.findings(states, BASE)
        assert finding.rule == "bath_fan_on"
        assert house_watch.switch_off_targets(states, BASE) == [("fan", "turn_off", "fan.main_bath_exhaust")]


class TestJournal:
    def test_records_how_long_something_lasted(self):
        door = row("cover.garage_door", "open", changed_ago=40 * MINUTE)
        states = [door]

        async def get_states():
            return states

        async def call_service(domain, service, data):
            return None

        async def scenario():
            watcher = house_watch.HouseWatch(get_states=get_states, call_service=call_service)
            await watcher.check_once(BASE)
            [ongoing] = watcher.journal_entries(BASE)
            assert ongoing["ongoing"] is True and ongoing["rule"] == "garage_open"
            states.clear()
            await watcher.check_once(BASE + 20 * MINUTE)
            [done] = watcher.journal_entries(BASE + 20 * MINUTE)
            assert done["ongoing"] is False
            assert done["seconds"] == 60 * MINUTE
            assert done["name"] == "cover.garage_door"

        run(scenario())
