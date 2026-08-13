"""Upkeep signals: consumables in two unit systems, a lying salt sensor, drift.

These cover the shapes this module actually meets on the live Home Assistant
install, not invented ones:

* Consumables arrive in two incompatible units. Roborock counts down *hours
  remaining* (`sensor.roborock_qrevo_maxv_filter_time_left` = 118.9h) while LG
  and Dyson report *percent of life left* (`sensor.refrigerator_water_filter` =
  0%). Only the hours case needs a service interval, and that interval is
  manufacturer data rather than something the device said -- which is exactly
  what the `derived` flag is for, and why it is asserted per unit below.
* A Roborock consumable goes *negative* once its interval is exceeded
  (`sensor.roborock_qrevo_maxv_sensor_time_left` was observed at -29.97h). The
  fraction floors at 0, so without the separate `overdue` flag the past-due
  state would clamp away silently and read as merely "empty". That real reading
  also exposed a bug: `sensor_time_left` matched no `CONSUMABLE_HINTS` entry
  despite having a service interval, so the only genuinely overdue item on this
  install was dropped before it could be ranked. `"time_left"` is now a hint,
  and a test below holds that.
* `sensor.dyson_..._hepa_filter_type` is the cartridge model ("EHEP"), not a
  life figure. Anything ending `_type` has to be excluded or a model number
  gets ranked as a percentage.
* The salt sensor on this install is genuinely miscalibrated: the percentage
  collapsed 60% -> 0% while the depth reading barely moved (43.5cm -> 42.1cm).
  Trusting the percentage shows a false "refill now", so `salt_status` prefers
  depth and reports the disagreement instead of hiding it. The depth scale is
  *inverted* -- more centimetres means less salt, because the sensor looks down
  at it -- and reading that backwards would call a full tank empty, so it is
  asserted explicitly.
* `changePercent` divides by last month's total, which is `0` for an appliance
  installed this month.

Everything is built from inline fake `/api/states` dicts; nothing here touches
the network or a live Home Assistant.
"""

import pytest

from app import maintenance


def row(
    entity_id: str,
    state,
    *,
    unit: str | None = None,
    name: str | None = None,
    device_class: str | None = None,
    **attributes,
) -> dict:
    """One entry of the `/api/states` payload the dashboard already fetches."""
    attrs: dict = dict(attributes)
    if unit is not None:
        attrs["unit_of_measurement"] = unit
    if name is not None:
        attrs["friendly_name"] = name
    if device_class is not None:
        attrs["device_class"] = device_class
    return {"entity_id": entity_id, "state": str(state), "attributes": attrs}


def hours(entity_id: str, remaining: float, **kwargs) -> dict:
    """A Roborock consumable, which reports hours left rather than a percentage."""
    return row(entity_id, remaining, unit="h", **kwargs)


def percent(entity_id: str, life_left: float, **kwargs) -> dict:
    """An LG/Dyson consumable, which reports percent of life remaining."""
    return row(entity_id, life_left, unit="%", **kwargs)


SALT_DEPTH = "sensor.esphome_web_79cc76_salt_level"
SALT_PERCENT = "sensor.esphome_web_79cc76_salt_level_percent"


def salt(depth=None, reported=None) -> list[dict]:
    """The softener's pair of sensors; either side can be left out or dead."""
    states = []
    if depth is not None:
        states.append(row(SALT_DEPTH, depth, unit="cm", name="Salt level"))
    if reported is not None:
        states.append(row(SALT_PERCENT, reported, unit="%", name="Salt level percent"))
    return states


def garage(door_state: str = "closed", **overrides) -> list[dict]:
    """The ratgdo door plus the entities `garage_status` reads around it."""
    states = [
        row("cover.ratgdov25i_8e54c8_door", door_state, device_class="garage", name="Garage Door"),
        row("number.ratgdov25i_8e54c8_opening_duration", overrides.get("opening", 12.9), unit="s"),
        row("number.ratgdov25i_8e54c8_closing_duration", overrides.get("closing", 10.9), unit="s"),
        row("binary_sensor.ratgdov25i_8e54c8_obstruction", overrides.get("obstruction", "off")),
        row("binary_sensor.ratgdov25i_8e54c8_open_limit_switch", overrides.get("open_limit", "off")),
        row("binary_sensor.ratgdov25i_8e54c8_close_limit_switch", overrides.get("close_limit", "on")),
        row("sensor.ratgdov25i_8e54c8_firmware_version", overrides.get("firmware", "v25.1")),
    ]
    return states


class TestConsumablesUnits:
    def test_a_percentage_is_already_a_fraction_of_life(self):
        states = [percent("sensor.refrigerator_water_filter", 40, name="Water filter")]
        item = maintenance.consumables(states)[0]
        assert item["entityId"] == "sensor.refrigerator_water_filter"
        assert item["name"] == "Water filter"
        assert item["fraction"] == 0.4
        assert item["percent"] == 40.0
        assert item["remainingHours"] is None
        assert item["derived"] is False
        assert item["severity"] == "ok"

    def test_hours_remaining_are_divided_by_the_service_interval_and_marked_derived(self):
        """118.9h of filter life means nothing on its own. The 150h interval used
        to turn it into a percentage is manufacturer data the device never
        reported, so `derived` has to say so rather than let the UI present it as
        a device reading."""
        states = [hours("sensor.roborock_qrevo_maxv_filter_time_left", 118.9, name="Filter time left")]
        item = maintenance.consumables(states)[0]
        assert item["remainingHours"] == 118.9
        assert item["fraction"] == 0.7927
        assert item["percent"] == 79.3
        assert item["derived"] is True
        assert item["overdue"] is False
        assert item["severity"] == "ok"

    def test_an_exhausted_percentage_filter_is_critical(self):
        # The real observation: the fridge's water filter sat at 0%.
        states = [percent("sensor.refrigerator_water_filter", 0, name="Water filter")]
        item = maintenance.consumables(states)[0]
        assert (item["fraction"], item["percent"]) == (0.0, 0.0)
        assert item["severity"] == "critical"

    def test_a_fifth_of_life_left_is_a_warning(self):
        states = [percent("sensor.dyson_hepa_filter_life", 20, name="HEPA life")]
        assert maintenance.consumables(states)[0]["severity"] == "warning"

    def test_an_out_of_range_percentage_is_clamped_to_a_fraction(self):
        states = [
            percent("sensor.washer_filter_life", 140, name="High"),
            percent("sensor.dryer_filter_life", -20, name="Low"),
        ]
        by_id = {item["entityId"]: item for item in maintenance.consumables(states)}
        assert by_id["sensor.washer_filter_life"]["fraction"] == 1.0
        assert by_id["sensor.dryer_filter_life"]["fraction"] == 0.0

    def test_an_unrecognised_unit_is_skipped(self):
        """A consumable reported in days or with no unit cannot be normalised, and
        guessing which of the two shapes it is would rank it wrongly."""
        states = [
            row("sensor.hvac_filter_days_left", 12, unit="d", name="Days left"),
            row("sensor.pool_filter_pressure", 18, name="No unit"),
        ]
        assert maintenance.consumables(states) == []

    def test_a_dead_consumable_sensor_is_skipped(self):
        states = [
            percent("sensor.refrigerator_water_filter", "unavailable"),
            hours("sensor.roborock_qrevo_maxv_filter_time_left", "unknown"),
        ]
        assert maintenance.consumables(states) == []

    def test_a_non_numeric_state_is_skipped(self):
        states = [percent("sensor.refrigerator_water_filter", "clean")]
        assert maintenance.consumables(states) == []

    def test_entities_outside_the_sensor_domain_are_ignored(self):
        states = [row("binary_sensor.dyson_filter_replacement", "off"), row("switch.filter_pump", "on")]
        assert maintenance.consumables(states) == []

    def test_something_that_is_not_a_wear_item_is_ignored(self):
        states = [percent("sensor.hall_sensor_battery", 88, name="Battery")]
        assert maintenance.consumables(states) == []

    def test_a_cartridge_model_number_is_not_treated_as_a_life_figure(self):
        """`..._hepa_filter_type` holds "EHEP", the cartridge model. If a model
        that happens to parse as a number slipped through it would be ranked as
        a percentage of life remaining."""
        states = [
            row("sensor.dyson_purecool_hepa_filter_type", "EHEP", name="HEPA type"),
            percent("sensor.dyson_purecool_carbon_filter_type", 909, name="Carbon type"),
            percent("sensor.dyson_purecool_filter_type_code", 12, name="Type code"),
        ]
        assert maintenance.consumables(states) == []


class TestConsumablesOverdue:
    def test_a_negative_remainder_is_overdue_and_critical(self):
        """A Roborock consumable counts *past* zero once its interval is
        exceeded (-29.97h was observed on this vacuum). The fraction floors at 0
        so the panel can rank it, but if the past-due state were only carried in
        the fraction it would be indistinguishable from a consumable that has
        just reached empty."""
        states = [hours("sensor.roborock_qrevo_maxv_dock_strainer_time_left", -29.97, name="Dock strainer")]
        item = maintenance.consumables(states)[0]
        assert item["remainingHours"] == -30.0
        assert item["fraction"] == 0.0
        assert item["overdue"] is True
        assert item["severity"] == "critical"

    def test_the_dust_sensor_consumable_is_not_dropped(self):
        """`SERVICE_INTERVAL_HOURS` carries a 30h interval for `sensor`, so it is
        meant to be a tracked wear item, but `CONSUMABLE_HINTS` has no entry that
        matches `..._sensor_time_left`. The one consumable observed genuinely
        overdue is therefore the one that never reaches the panel."""
        states = [hours("sensor.roborock_qrevo_maxv_sensor_time_left", -29.97, name="Sensor time left")]
        assert maintenance.consumables(states)

    def test_exactly_zero_hours_left_is_already_overdue(self):
        states = [hours("sensor.roborock_qrevo_maxv_main_brush_time_left", 0, name="Main brush")]
        item = maintenance.consumables(states)[0]
        assert item["overdue"] is True
        assert item["severity"] == "critical"

    def test_hours_remaining_are_never_reported_as_overdue(self):
        states = [hours("sensor.roborock_qrevo_maxv_side_brush_time_left", 41.0)]
        assert maintenance.consumables(states)[0]["overdue"] is False

    def test_a_device_replacement_flag_overrides_a_merely_low_percentage(self):
        """The device knows things a percentage cannot express, so a Dyson that
        raises its own "replace filter" flag is critical even though 15% would
        only warn."""
        states = [
            percent("sensor.dyson_purecool_hepa_filter_life", 15, name="HEPA life"),
            row("binary_sensor.dyson_purecool_filter_replacement", "on"),
        ]
        item = maintenance.consumables(states)[0]
        assert item["severity"] == "critical"
        assert item["fraction"] == 0.15

    def test_a_quiet_replacement_flag_leaves_the_percentage_alone(self):
        states = [
            percent("sensor.dyson_purecool_hepa_filter_life", 15, name="HEPA life"),
            row("binary_sensor.dyson_purecool_filter_replacement", "off"),
        ]
        assert maintenance.consumables(states)[0]["severity"] == "warning"


class TestConsumablesOrdering:
    def test_the_most_urgent_consumable_is_listed_first(self):
        states = [
            hours("sensor.roborock_qrevo_maxv_filter_time_left", 118.9),
            percent("sensor.dyson_purecool_hepa_filter_life", 45),
            hours("sensor.roborock_qrevo_maxv_side_brush_time_left", 30.0),
            percent("sensor.refrigerator_water_filter", 0),
        ]
        found = maintenance.consumables(states)
        assert [item["entityId"] for item in found] == [
            "sensor.refrigerator_water_filter",
            "sensor.roborock_qrevo_maxv_side_brush_time_left",
            "sensor.dyson_purecool_hepa_filter_life",
            "sensor.roborock_qrevo_maxv_filter_time_left",
        ]
        assert [item["severity"] for item in found] == ["critical", "warning", "ok", "ok"]

    def test_items_of_equal_severity_are_ranked_by_life_remaining(self):
        states = [
            percent("sensor.b_filter_life", 90),
            percent("sensor.a_filter_life", 30),
        ]
        found = maintenance.consumables(states)
        assert [item["entityId"] for item in found] == ["sensor.a_filter_life", "sensor.b_filter_life"]


class TestIntervalMatching:
    def test_the_longest_matching_key_wins(self):
        """`dock_maintenance_brush` contains `brush`, and `dock_strainer` has to
        find its own 90h interval rather than borrowing a brush's."""
        assert maintenance._interval_for("sensor.roborock_dock_maintenance_brush_time_left") == 300.0
        assert maintenance._interval_for("sensor.roborock_dock_strainer_time_left") == 90.0
        assert maintenance._interval_for("sensor.roborock_side_brush_time_left") == 200.0
        assert maintenance._interval_for("sensor.roborock_main_brush_time_left") == 300.0

    def test_a_filter_is_not_matched_by_the_sensor_key(self):
        # Both keys are six characters long, so tie-breaking has to keep a
        # filter on its own 150h interval.
        assert maintenance._interval_for("sensor.roborock_filter_time_left") == 150.0

    def test_the_dust_sensor_interval_is_the_short_one(self):
        assert maintenance._interval_for("sensor.roborock_sensor_time_left") == 30.0

    def test_an_unrecognised_wear_item_has_no_interval(self):
        assert maintenance._interval_for("number.hvac_belt_time_left") is None

    def test_a_strainer_in_hours_uses_its_own_interval(self):
        states = [hours("sensor.roborock_qrevo_maxv_dock_strainer_time_left", 45.0)]
        assert maintenance.consumables(states)[0]["fraction"] == 0.5


class TestSaltStatus:
    def test_the_depth_reading_is_trusted_over_a_collapsed_percentage(self):
        """The real fault on this install: the percentage fell 60% -> 0% while
        the depth barely moved, 43.5cm -> 42.1cm. Believing the percentage would
        show "refill now" on a tank that is a third full, so depth wins and the
        disagreement is reported so the sensor can be recalibrated."""
        status = maintenance.salt_status(salt(depth=43.5, reported=0))
        assert status["depthCm"] == 43.5
        assert status["reportedPercent"] == 0.0
        assert status["percent"] == pytest.approx(28.75, abs=0.1)
        assert status["fromDepth"] is True
        assert status["sensorDisagrees"] is True
        assert status["severity"] == "ok"

    def test_more_centimetres_means_less_salt(self):
        """The scale is inverted -- the sensor looks down at the salt from the top
        of the tank, so a bigger distance is a emptier tank. Reading it the other
        way round would report a full tank as needing a refill."""
        nearly_full = maintenance.salt_status(salt(depth=20.0))
        nearly_empty = maintenance.salt_status(salt(depth=50.0))
        assert nearly_full["percent"] > nearly_empty["percent"]
        assert nearly_full["percent"] == 87.5
        assert nearly_empty["percent"] == 12.5

    def test_the_calibrated_ends_of_the_range_are_full_and_empty(self):
        assert maintenance.salt_status(salt(depth=maintenance.SALT_FULL_CM))["percent"] == 100.0
        assert maintenance.salt_status(salt(depth=maintenance.SALT_EMPTY_CM))["percent"] == 0.0

    def test_a_depth_beyond_either_end_is_clamped(self):
        assert maintenance.salt_status(salt(depth=2.0))["percent"] == 100.0
        assert maintenance.salt_status(salt(depth=80.0))["percent"] == 0.0

    def test_depth_alone_is_enough(self):
        status = maintenance.salt_status(salt(depth=35.0))
        assert status["percent"] == 50.0
        assert status["reportedPercent"] is None
        assert status["fromDepth"] is True
        assert status["sensorDisagrees"] is False
        assert status["severity"] == "ok"

    def test_the_reported_percentage_is_used_when_there_is_no_depth_sensor(self):
        status = maintenance.salt_status(salt(reported=42))
        assert status["percent"] == 42.0
        assert status["depthCm"] is None
        assert status["fromDepth"] is False
        assert status["sensorDisagrees"] is False

    def test_a_small_disagreement_is_not_flagged(self):
        """The two readings never agree exactly; only a gap big enough to change
        the answer is worth calling a calibration fault."""
        status = maintenance.salt_status(salt(depth=35.0, reported=60))
        assert status["percent"] == 50.0
        assert status["sensorDisagrees"] is False

    def test_a_gap_of_the_full_threshold_is_flagged(self):
        status = maintenance.salt_status(salt(depth=45.0, reported=0))
        assert status["percent"] == 25.0
        assert status["sensorDisagrees"] is True

    def test_a_genuinely_empty_tank_is_still_critical(self):
        # Depth is trusted in both directions: it can confirm a refill is due.
        status = maintenance.salt_status(salt(depth=54.0, reported=2))
        assert status["severity"] == "critical"
        assert status["sensorDisagrees"] is False

    def test_a_low_tank_warns(self):
        assert maintenance.salt_status(salt(depth=51.0))["severity"] == "warning"

    def test_no_softener_sensors_at_all_reports_nothing(self):
        assert maintenance.salt_status([row("light.kitchen", "on")]) is None

    def test_dead_softener_sensors_report_an_unknown_level_rather_than_zero(self):
        """Both sensors present but unavailable is not an empty tank, and showing
        0% would send someone out for salt they do not need."""
        status = maintenance.salt_status(salt(depth="unavailable", reported="unknown"))
        assert status["percent"] is None
        assert status["depthCm"] is None
        assert status["reportedPercent"] is None
        assert status["fromDepth"] is False
        assert status["severity"] == "unknown"

    def test_a_dead_depth_sensor_falls_back_to_the_percentage(self):
        status = maintenance.salt_status(salt(depth="unavailable", reported=65))
        assert status["percent"] == 65.0
        assert status["fromDepth"] is False


class TestGarageStatus:
    def test_travel_durations_are_surfaced_as_the_drift_signal(self):
        """Nothing in Home Assistant watches these numbers for change, and a door
        that takes gradually longer to travel has a spring or roller going."""
        status = maintenance.garage_status(garage())
        assert status["openingSeconds"] == 12.9
        assert status["closingSeconds"] == 10.9
        assert status["durationEntities"] == [
            "number.ratgdov25i_8e54c8_opening_duration",
            "number.ratgdov25i_8e54c8_closing_duration",
        ]

    def test_position_obstruction_and_limits_come_through(self):
        status = maintenance.garage_status(garage("open", obstruction="on", open_limit="on", close_limit="off"))
        assert status["entityId"] == "cover.ratgdov25i_8e54c8_door"
        assert status["state"] == "open"
        assert status["obstructed"] is True
        assert status["openLimit"] == "on"
        assert status["closeLimit"] == "off"
        assert status["firmware"] == "v25.1"

    def test_a_clear_door_is_not_reported_as_obstructed(self):
        assert maintenance.garage_status(garage())["obstructed"] is False

    def test_a_missing_obstruction_sensor_is_not_an_obstruction(self):
        states = [entity for entity in garage() if "obstruction" not in entity["entity_id"]]
        assert maintenance.garage_status(states)["obstructed"] is False

    def test_a_dead_duration_entity_reports_no_number_rather_than_zero(self):
        # A zero-second travel time would look like a brand new door, which is
        # the opposite of the drift this is meant to catch.
        status = maintenance.garage_status(garage(opening="unavailable"))
        assert status["openingSeconds"] is None
        assert status["closingSeconds"] == 10.9

    def test_an_install_without_the_door_reports_nothing(self):
        states = [entity for entity in garage() if not entity["entity_id"].startswith("cover.")]
        assert maintenance.garage_status(states) is None

    def test_a_home_with_no_garage_entities_reports_nothing(self):
        assert maintenance.garage_status([row("light.kitchen", "on")]) is None


class TestDeviceFaults:
    def test_a_tripped_problem_sensor_is_reported(self):
        states = [row("binary_sensor.dishwasher_problem", "on", device_class="problem", name="Dishwasher problem")]
        assert maintenance.device_faults(states) == [
            {"entityId": "binary_sensor.dishwasher_problem", "name": "Dishwasher problem"}
        ]

    def test_a_fault_named_sensor_counts_without_a_device_class(self):
        """Integrations fan out `fault_*` and `error_*` sensors with no device
        class at all; those are the ones that are invisible until they trip."""
        states = [
            row("binary_sensor.boiler_fault_flame", "on", name="Flame fault"),
            row("binary_sensor.inverter_error_grid", "on", name="Grid error"),
        ]
        assert [item["entityId"] for item in maintenance.device_faults(states)] == [
            "binary_sensor.boiler_fault_flame",
            "binary_sensor.inverter_error_grid",
        ]

    def test_a_quiet_fault_sensor_is_not_reported(self):
        # Almost all of them sit at `off` forever; listing those would bury the
        # one that matters.
        states = [
            row("binary_sensor.boiler_fault_flame", "off", name="Flame fault"),
            row("binary_sensor.dishwasher_problem", "off", device_class="problem"),
        ]
        assert maintenance.device_faults(states) == []

    def test_an_unrelated_active_binary_sensor_is_not_a_fault(self):
        states = [
            row("binary_sensor.hallway_motion", "on", device_class="motion"),
            row("binary_sensor.front_door", "on", device_class="door"),
        ]
        assert maintenance.device_faults(states) == []

    def test_an_unavailable_fault_sensor_is_not_a_fault(self):
        states = [row("binary_sensor.boiler_fault_flame", "unavailable")]
        assert maintenance.device_faults(states) == []

    def test_other_domains_are_ignored(self):
        states = [row("sensor.boiler_fault_code", "on", name="Fault code")]
        assert maintenance.device_faults(states) == []

    def test_faults_are_listed_in_a_stable_order(self):
        states = [
            row("binary_sensor.zebra_problem", "on", device_class="problem"),
            row("binary_sensor.alpha_problem", "on", device_class="problem"),
        ]
        assert [item["entityId"] for item in maintenance.device_faults(states)] == [
            "binary_sensor.alpha_problem",
            "binary_sensor.zebra_problem",
        ]

    def test_the_entity_id_stands_in_for_a_missing_friendly_name(self):
        states = [row("binary_sensor.boiler_fault_flame", "on")]
        assert maintenance.device_faults(states)[0]["name"] == "binary_sensor.boiler_fault_flame"


class TestApplianceUsage:
    def test_month_over_month_change_is_computed_per_device(self):
        states = [
            row("sensor.washer_energy_this_month", 1500, unit="Wh"),
            row("sensor.washer_energy_last_month", 1000, unit="Wh"),
            row("sensor.washer_cycles", 42),
            row("sensor.washer_current_status", "idle"),
        ]
        found = maintenance.appliance_usage(states)
        assert len(found) == 1
        item = found[0]
        assert item["device"] == "washer"
        assert item["name"] == "Washer"
        assert item["thisMonthWh"] == 1500.0
        assert item["lastMonthWh"] == 1000.0
        assert item["cycles"] == 42.0
        assert item["changePercent"] == 50.0
        assert item["status"] == "idle"
        assert set(item["entityIds"]) == {
            "sensor.washer_energy_this_month",
            "sensor.washer_energy_last_month",
            "sensor.washer_cycles",
        }

    def test_a_drop_in_usage_is_a_negative_change(self):
        states = [
            row("sensor.refrigerator_energy_this_month", 800, unit="Wh"),
            row("sensor.refrigerator_energy_last_month", 1000, unit="Wh"),
        ]
        assert maintenance.appliance_usage(states)[0]["changePercent"] == -20.0

    def test_a_first_month_with_nothing_to_compare_to_does_not_divide_by_zero(self):
        """An appliance installed this month has `last_month` at 0. Dividing by
        it would raise; reporting no change is the honest answer."""
        states = [
            row("sensor.washer_energy_this_month", 1500, unit="Wh"),
            row("sensor.washer_energy_last_month", 0, unit="Wh"),
        ]
        item = maintenance.appliance_usage(states)[0]
        assert item["changePercent"] is None
        assert item["thisMonthWh"] == 1500.0

    def test_a_missing_last_month_sensor_reports_no_change(self):
        states = [row("sensor.washer_energy_this_month", 1500, unit="Wh")]
        item = maintenance.appliance_usage(states)[0]
        assert item["changePercent"] is None
        assert "lastMonthWh" not in item

    def test_a_missing_this_month_sensor_reports_no_change(self):
        states = [row("sensor.washer_energy_last_month", 1000, unit="Wh")]
        assert maintenance.appliance_usage(states)[0]["changePercent"] is None

    def test_a_dead_energy_sensor_is_skipped(self):
        states = [
            row("sensor.washer_energy_this_month", 1500, unit="Wh"),
            row("sensor.washer_energy_last_month", "unavailable", unit="Wh"),
        ]
        assert maintenance.appliance_usage(states)[0]["changePercent"] is None

    def test_a_non_numeric_total_is_skipped(self):
        states = [
            row("sensor.washer_energy_this_month", 1500, unit="Wh"),
            row("sensor.washer_energy_last_month", "none", unit="Wh"),
        ]
        assert maintenance.appliance_usage(states)[0]["changePercent"] is None

    def test_a_device_with_no_status_sensor_reports_no_status(self):
        states = [row("sensor.dryer_cycles", 12)]
        assert maintenance.appliance_usage(states)[0]["status"] is None

    def test_unrelated_sensors_are_not_appliances(self):
        states = [
            row("sensor.office_temperature", 21.4, unit="°C"),
            row("sensor.solar_energy_today", 4200, unit="Wh"),
        ]
        assert maintenance.appliance_usage(states) == []

    def test_appliances_are_listed_alphabetically(self):
        states = [
            row("sensor.washer_cycles", 4),
            row("sensor.dishwasher_cycles", 9),
        ]
        assert [item["name"] for item in maintenance.appliance_usage(states)] == ["Dishwasher", "Washer"]

    def test_a_multiword_device_id_becomes_a_readable_name(self):
        states = [row("sensor.laundry_room_dryer_cycles", 3)]
        assert maintenance.appliance_usage(states)[0]["name"] == "Laundry Room Dryer"


class TestMaintenanceSummary:
    def _install(self) -> list[dict]:
        return [
            percent("sensor.refrigerator_water_filter", 0, name="Water filter"),
            hours("sensor.roborock_qrevo_maxv_dock_strainer_time_left", -29.97, name="Dock strainer"),
            hours("sensor.roborock_qrevo_maxv_side_brush_time_left", 30.0, name="Side brush"),
            hours("sensor.roborock_qrevo_maxv_filter_time_left", 118.9, name="Filter time left"),
            row("sensor.dyson_purecool_hepa_filter_type", "EHEP", name="HEPA type"),
            row("binary_sensor.dishwasher_problem", "on", device_class="problem", name="Dishwasher problem"),
            row("sensor.washer_energy_this_month", 1500, unit="Wh"),
            row("sensor.washer_energy_last_month", 1000, unit="Wh"),
            *salt(depth=43.5, reported=0),
            *garage(),
        ]

    def test_the_shape_is_the_five_panels_plus_counts(self):
        summary = maintenance.maintenance_summary(self._install())
        assert set(summary) == {"consumables", "salt", "garage", "faults", "appliances", "counts"}
        assert set(summary["counts"]) == {"critical", "warning", "ok"}

    def test_counts_match_the_consumables_listed(self):
        summary = maintenance.maintenance_summary(self._install())
        assert summary["counts"] == {"critical": 2, "warning": 1, "ok": 1}
        assert sum(summary["counts"].values()) == len(summary["consumables"])

    def test_every_panel_is_populated_from_one_states_payload(self):
        summary = maintenance.maintenance_summary(self._install())
        assert summary["salt"]["sensorDisagrees"] is True
        assert summary["garage"]["openingSeconds"] == 12.9
        assert [item["entityId"] for item in summary["faults"]] == ["binary_sensor.dishwasher_problem"]
        assert [item["device"] for item in summary["appliances"]] == ["washer"]

    def test_the_generator_is_consumed_once_and_reused(self):
        """Every panel walks the same payload, so a generator would leave all but
        the first of them empty."""
        summary = maintenance.maintenance_summary(entity for entity in self._install())
        assert summary["consumables"]
        assert summary["salt"] is not None
        assert summary["garage"] is not None
        assert summary["faults"]
        assert summary["appliances"]

    def test_an_install_with_none_of_these_devices_is_survived(self):
        summary = maintenance.maintenance_summary([row("light.kitchen", "on")])
        assert summary["consumables"] == []
        assert summary["salt"] is None
        assert summary["garage"] is None
        assert summary["faults"] == []
        assert summary["appliances"] == []
        assert summary["counts"] == {"critical": 0, "warning": 0, "ok": 0}

    def test_an_empty_payload_is_survived(self):
        summary = maintenance.maintenance_summary([])
        assert summary["counts"] == {"critical": 0, "warning": 0, "ok": 0}
