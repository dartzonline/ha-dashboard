"""Whole-home health checks: frozen sensors, silent failures, dead duplicates.

These cover the findings this module actually produced against the live Home
Assistant install, rather than invented ones:

* Automatic backups had been failing for 81 days. `last_attempted` was today and
  `last_successful` was in May; each sensor looked healthy on its own, so only
  the gap between the two is the fault to detect.
* A lawn-moisture sensor had been stuck at `0%` for eight days while its sibling
  updated normally. Home Assistant flags nothing, because `0` is a valid number.
* A Home Assistant restart rewrites `last_changed` on hundreds of entities at
  once. An early version read that as "hundreds of sensors froze at the same
  instant" and emitted 110 warnings, burying the four real ones -- hence the
  restart-burst rule, and hence the grace period that still lets a burst older
  than 36h count as genuine staleness (that is what keeps the maple sensor
  visible). Both sides of that rule are tested explicitly below.
* Re-pairing a device leaves the old entities behind as permanently
  `unavailable` beside a working twin. Pairing dead with replacement is what
  makes them safe to delete; an unavailable entity with *no* twin may be real
  broken hardware and must never be listed as safe to delete.

Every test passes an explicit `now=`, so nothing here depends on wall-clock time
or on any live Home Assistant.
"""

from datetime import datetime, timezone

from app import home_health

BASE = 1_700_000_000.0
HOUR = 3600.0
DAY = 86400.0


def stamp(seconds_ago: float, now: float = BASE) -> str:
    """An HA-style `last_changed` string that many seconds before `now`."""
    return datetime.fromtimestamp(now - seconds_ago, timezone.utc).isoformat().replace("+00:00", "Z")


def row(
    entity_id: str,
    state,
    *,
    changed_ago: float = 60.0,
    device_class: str | None = None,
    unit: str | None = None,
    name: str | None = None,
    **attributes,
) -> dict:
    """One entry of the `/api/states` payload the dashboard already fetches."""
    attrs: dict = dict(attributes)
    if device_class is not None:
        attrs["device_class"] = device_class
    if unit is not None:
        attrs["unit_of_measurement"] = unit
    if name is not None:
        attrs["friendly_name"] = name
    return {
        "entity_id": entity_id,
        "state": str(state),
        "last_changed": stamp(changed_ago),
        "attributes": attrs,
    }


def healthy_backup(days_ago: float = 0.25) -> list[dict]:
    """The pair of backup sensors in their happy state, so fixtures for other
    checks do not accidentally raise a backup alert."""
    return [
        row("sensor.backup_last_successful_automatic_backup", stamp(days_ago * DAY)),
        row("sensor.backup_last_attempted_automatic_backup", stamp(days_ago * DAY)),
    ]


class TestStaleSensors:
    def test_a_frozen_moisture_sensor_is_flagged(self):
        states = [
            row(
                "sensor.lawn_plant_sensor_maple_humidity",
                0,
                changed_ago=8 * DAY,
                device_class="humidity",
                unit="%",
                name="Maple moisture",
            )
        ]
        found = home_health.stale_sensors(states, now=BASE)
        assert len(found) == 1
        assert found[0]["entityId"] == "sensor.lawn_plant_sensor_maple_humidity"
        assert found[0]["name"] == "Maple moisture"
        assert found[0]["state"] == "0"
        assert found[0]["unit"] == "%"
        assert found[0]["staleSeconds"] == round(8 * DAY)

    def test_a_recently_updated_sensor_is_left_alone(self):
        states = [row("sensor.office_temperature", 21.4, changed_ago=90.0, device_class="temperature")]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_a_flat_battery_reading_is_not_staleness(self):
        """A healthy coin cell sits at 100% for months. Judging batteries for
        staleness is what produced 110 warnings and hid the real four."""
        states = [
            row("sensor.front_door_battery", 100, changed_ago=60 * DAY, device_class="battery", unit="%"),
            row("sensor.front_door_voltage", 3.0, changed_ago=60 * DAY, device_class="voltage", unit="V"),
        ]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_exempt_entity_ids_are_skipped_even_with_a_watched_class(self):
        # "_last_" marks a value that describes a past event; it is supposed to
        # sit still until the next one happens.
        states = [row("sensor.grill_last_temperature", 63.0, changed_ago=9 * DAY, device_class="temperature")]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_a_non_numeric_reading_is_not_judged(self):
        """A text/enum sensor holding one word for days is ordinary."""
        states = [row("sensor.air_quality_index", "moderate", changed_ago=9 * DAY, device_class="aqi")]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_an_unavailable_sensor_is_not_reported_as_stale(self):
        # Being unavailable is its own problem, reported elsewhere; calling it
        # stale as well would double-count it.
        states = [row("sensor.shed_temperature", "unavailable", changed_ago=9 * DAY, device_class="temperature")]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_a_non_sensor_domain_is_ignored(self):
        states = [row("binary_sensor.hallway_motion", "off", changed_ago=9 * DAY, device_class="moisture")]
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_a_missing_last_changed_is_survived(self):
        entity = row("sensor.attic_temperature", 18.0, device_class="temperature")
        entity["last_changed"] = None
        assert home_health.stale_sensors([entity], now=BASE) == []

    def _burst(self, count: int, age: float) -> list[dict]:
        """`count` sensors that all share one `last_changed` to the minute --
        the signature of a Home Assistant restart, not of a mass freeze."""
        return [
            row(f"sensor.room_{index}_temperature", 20 + index, changed_ago=age, device_class="temperature")
            for index in range(count)
        ]

    def test_a_recent_restart_burst_is_not_reported(self):
        """The bug this rule exists for: a restart rewrites `last_changed` on
        hundreds of entities, and reading that as staleness produced a wall of
        warnings that buried the real findings."""
        states = self._burst(home_health.RESTART_BURST_MIN, 30 * HOUR)
        assert home_health.stale_sensors(states, now=BASE) == []

    def test_a_burst_older_than_the_grace_period_is_still_real_staleness(self):
        """The other side of the same rule. A live sensor produces a reading
        within minutes of coming back, so nothing legitimately still carries a
        restart timestamp days later -- this is what keeps the maple sensor
        visible while today's restart stays quiet."""
        age = 8 * DAY
        assert age > home_health.RESTART_BURST_GRACE_S
        states = self._burst(home_health.RESTART_BURST_MIN, age)
        states.append(
            row(
                "sensor.lawn_plant_sensor_maple_humidity",
                0,
                changed_ago=age,
                device_class="humidity",
                unit="%",
            )
        )
        found = home_health.stale_sensors(states, now=BASE)
        ids = {item["entityId"] for item in found}
        assert "sensor.lawn_plant_sensor_maple_humidity" in ids
        assert len(found) == len(states)

    def test_a_crowd_smaller_than_the_burst_threshold_is_still_reported(self):
        """Below the burst size there is no reason to suspect a restart, so a
        handful of sensors sharing a timestamp are judged normally."""
        states = self._burst(home_health.RESTART_BURST_MIN - 1, 30 * HOUR)
        assert len(home_health.stale_sensors(states, now=BASE)) == len(states)

    def test_the_stalest_sensor_is_listed_first(self):
        states = [
            row("sensor.kitchen_temperature", 20, changed_ago=2 * DAY, device_class="temperature"),
            row("sensor.garage_temperature", 12, changed_ago=9 * DAY, device_class="temperature"),
        ]
        found = home_health.stale_sensors(states, now=BASE)
        assert [item["entityId"] for item in found] == [
            "sensor.garage_temperature",
            "sensor.kitchen_temperature",
        ]


class TestAttentionItems:
    def test_a_healthy_home_raises_nothing(self):
        """A panel that cries wolf gets ignored, and then the one real problem
        in it goes unread too."""
        states = [
            row("light.kitchen", "on", changed_ago=5 * DAY),
            row("sensor.office_temperature", 21.4, changed_ago=120.0, device_class="temperature"),
            row("sensor.front_door_battery", 88, changed_ago=40 * DAY, device_class="battery", unit="%"),
            row("binary_sensor.front_door", "off", changed_ago=6 * HOUR, device_class="door"),
            row("update.core", "off", changed_ago=3 * DAY),
            row("sensor.vacuum_filter_left", 74, unit="%"),
            *healthy_backup(),
        ]
        assert home_health.attention_items(states, now=BASE) == []

    def test_an_active_problem_sensor_is_surfaced(self):
        states = [row("binary_sensor.dishwasher_problem", "on", device_class="problem", name="Dishwasher problem")]
        items = home_health.attention_items(states, now=BASE)
        assert len(items) == 1
        assert items[0]["category"] == "problem"
        assert items[0]["severity"] == "warning"
        assert items[0]["title"] == "Dishwasher problem"

    def test_a_low_battery_warns_and_a_dying_one_is_critical(self):
        states = [
            row("sensor.hall_sensor_battery", 20, device_class="battery", unit="%", name="Hall battery"),
            row("sensor.attic_sensor_battery", 8, device_class="battery", unit="%", name="Attic battery"),
        ]
        by_id = {item["entityId"]: item for item in home_health.attention_items(states, now=BASE)}
        assert by_id["sensor.hall_sensor_battery"]["severity"] == "warning"
        assert by_id["sensor.attic_sensor_battery"]["severity"] == "critical"
        assert by_id["sensor.attic_sensor_battery"]["detail"] == "Battery at 8%"

    def test_a_comfortable_battery_is_not_mentioned(self):
        states = [row("sensor.hall_sensor_battery", 55, device_class="battery", unit="%")]
        assert home_health.attention_items(states, now=BASE) == []

    def test_a_pending_update_shows_the_version_move(self):
        states = [
            row(
                "update.home_assistant_core",
                "on",
                name="Home Assistant Core",
                installed_version="2024.1.1",
                latest_version="2024.2.0",
            )
        ]
        items = home_health.attention_items(states, now=BASE)
        assert items[0]["severity"] == "info"
        assert items[0]["detail"] == "2024.1.1 → 2024.2.0"

    def test_an_update_without_version_attributes_still_appears(self):
        states = [row("update.some_addon", "on", name="Some add-on")]
        assert home_health.attention_items(states, now=BASE)[0]["detail"] == "Update available"

    def test_an_open_door_or_window_is_informational(self):
        states = [
            row("binary_sensor.garage_door", "on", device_class="garage_door", name="Garage door"),
            row("binary_sensor.study_window", "on", device_class="window", name="Study window"),
        ]
        items = home_health.attention_items(states, now=BASE)
        assert {item["severity"] for item in items} == {"info"}
        assert {item["category"] for item in items} == {"opening"}
        assert len(items) == 2

    def test_a_leak_or_smoke_is_critical(self):
        states = [
            row("binary_sensor.basement_water_leak", "on", device_class="moisture", name="Basement leak"),
            row("binary_sensor.kitchen_smoke", "on", device_class="smoke", name="Kitchen smoke"),
        ]
        items = home_health.attention_items(states, now=BASE)
        assert [item["severity"] for item in items] == ["critical", "critical"]
        assert {item["detail"] for item in items} == {"Detected"}

    def test_a_worn_consumable_warns_and_an_exhausted_one_is_critical(self):
        states = [
            row("sensor.roborock_filter_left", 6, unit="%", name="Filter life"),
            row("sensor.roborock_main_brush_left", 0, unit="%", name="Main brush life"),
        ]
        by_id = {item["entityId"]: item for item in home_health.attention_items(states, now=BASE)}
        assert by_id["sensor.roborock_filter_left"]["severity"] == "warning"
        assert by_id["sensor.roborock_filter_left"]["detail"] == "6% life left"
        assert by_id["sensor.roborock_main_brush_left"]["severity"] == "critical"
        assert by_id["sensor.roborock_main_brush_left"]["detail"] == "Needs replacing"

    def test_a_stale_sensor_is_reported_with_a_readable_age(self):
        states = [
            row(
                "sensor.lawn_plant_sensor_maple_humidity",
                0,
                changed_ago=8 * DAY,
                device_class="humidity",
                unit="%",
                name="Maple moisture",
            )
        ]
        items = home_health.attention_items(states, now=BASE)
        assert items[0]["category"] == "stale"
        assert items[0]["severity"] == "warning"
        assert items[0]["detail"] == "Unchanged for 8d — reading 0%"

    def test_critical_items_sort_ahead_of_warnings_and_info(self):
        states = [
            row("update.some_addon", "on", name="Some add-on"),
            row("sensor.attic_sensor_battery", 40, device_class="battery", unit="%"),
            row("sensor.hall_sensor_battery", 18, device_class="battery", unit="%", name="Hall battery"),
            row("binary_sensor.basement_water_leak", "on", device_class="moisture", name="Basement leak"),
        ]
        ranks = [
            home_health._severity_rank(str(item["severity"]))
            for item in home_health.attention_items(states, now=BASE)
        ]
        assert ranks == sorted(ranks)
        assert ranks[0] == home_health._severity_rank("critical")


class TestBackupItems:
    def test_a_recent_success_says_nothing(self):
        states = [
            row("sensor.backup_last_successful_automatic_backup", stamp(6 * HOUR)),
            row("sensor.backup_last_attempted_automatic_backup", stamp(6 * HOUR)),
        ]
        assert home_health.attention_items(states, now=BASE) == []

    def test_eighty_one_days_without_a_success_is_critical_and_names_the_failures(self):
        """The real finding: attempted daily, succeeded in May. Both sensors read
        as healthy alone; only the distance between them is the fault."""
        states = [
            row("sensor.backup_last_successful_automatic_backup", stamp(81 * DAY)),
            row("sensor.backup_last_attempted_automatic_backup", stamp(2 * HOUR)),
        ]
        items = [item for item in home_health.attention_items(states, now=BASE) if item["category"] == "backup"]
        assert len(items) == 1
        assert items[0]["severity"] == "critical"
        assert items[0]["detail"] == "Last succeeded 81 days ago — attempts since then have failed"
        assert items[0]["entityId"] == "sensor.backup_last_successful_automatic_backup"

    def test_a_few_days_behind_is_only_a_warning(self):
        states = [row("sensor.backup_last_successful_automatic_backup", stamp(4 * DAY))]
        items = home_health.attention_items(states, now=BASE)
        assert items[0]["severity"] == "warning"
        # No newer attempt on record, so nothing is claimed about failures.
        assert items[0]["detail"] == "Last succeeded 4 days ago"

    def test_an_unparseable_success_timestamp_does_not_raise(self):
        states = [row("sensor.backup_last_successful_automatic_backup", "unknown")]
        items = home_health.attention_items(states, now=BASE)
        assert len(items) == 1
        assert items[0]["severity"] == "critical"
        assert items[0]["detail"] == "No successful backup on record"

    def test_an_install_without_the_backup_sensor_reports_nothing(self):
        # Only the attempted sensor exists (or neither) -- there is nothing to
        # compare against, so staying silent beats guessing.
        states = [row("sensor.backup_last_attempted_automatic_backup", stamp(HOUR))]
        assert home_health.attention_items(states, now=BASE) == []


class TestDuplicateEntities:
    def test_a_numeric_suffix_is_paired_with_its_base_twin(self):
        """`..._water_leak_6` is permanently unavailable next to a working
        `..._water_leak`: the suffix means the base id was already taken, by the
        entity that replaced this one."""
        states = [
            row("binary_sensor.basement_water_leak_6", "unavailable", name="Basement water leak"),
            row("binary_sensor.basement_water_leak", "off", name="Basement water leak"),
        ]
        found = home_health.duplicate_entities(states)
        assert found == [
            {
                "entityId": "binary_sensor.basement_water_leak_6",
                "name": "Basement water leak",
                "replacedBy": "binary_sensor.basement_water_leak",
            }
        ]

    def test_a_renamed_repair_is_paired_by_friendly_name(self):
        """The pantry door case: the dead entity kept its own id, and the
        replacement registered under a different one with the same name."""
        states = [
            row("binary_sensor.pantry_door_door", "unavailable", name="Pantry Door Door"),
            row("binary_sensor.kitchen_pantry_door_door", "off", name="Pantry Door Door"),
        ]
        found = home_health.duplicate_entities(states)
        assert len(found) == 1
        assert found[0]["replacedBy"] == "binary_sensor.kitchen_pantry_door_door"

    def test_a_same_named_entity_in_another_domain_is_not_a_twin(self):
        """A `sensor.` and a `binary_sensor.` sharing a name are two different
        measurements of one device, so deleting one would lose data."""
        states = [
            row("sensor.pantry_door", "unavailable", name="Pantry Door"),
            row("binary_sensor.pantry_door", "off", name="Pantry Door"),
        ]
        assert home_health.duplicate_entities(states) == []

    def test_a_suffixed_entity_whose_base_is_also_dead_is_not_paired(self):
        # Both halves broken means the device is gone, not duplicated.
        states = [
            row("binary_sensor.shed_leak_2", "unavailable", name="Shed leak"),
            row("binary_sensor.shed_leak", "unavailable", name="Shed leak"),
        ]
        assert home_health.duplicate_entities(states) == []

    def test_an_unavailable_entity_with_no_twin_is_not_a_duplicate(self):
        states = [
            row("sensor.attic_probe_temperature", "unavailable", name="Attic probe"),
            row("sensor.office_temperature", 21.0, name="Office temperature"),
        ]
        assert home_health.duplicate_entities(states) == []

    def test_live_entities_are_never_listed(self):
        states = [
            row("binary_sensor.basement_water_leak_6", "off", name="Basement water leak"),
            row("binary_sensor.basement_water_leak", "off", name="Basement water leak"),
        ]
        assert home_health.duplicate_entities(states) == []


class TestRegistrySummary:
    def test_totals_live_and_unavailable_are_counted(self):
        states = [
            row("light.kitchen", "on"),
            row("sensor.office_temperature", 21.0),
            row("binary_sensor.basement_water_leak", "off", name="Basement water leak"),
            row("binary_sensor.basement_water_leak_6", "unavailable", name="Basement water leak"),
        ]
        summary = home_health.registry_summary(states)
        assert summary["total"] == 4
        assert summary["live"] == 3
        assert summary["unavailable"] == 1
        assert [item["entityId"] for item in summary["duplicates"]] == ["binary_sensor.basement_water_leak_6"]
        assert summary["orphans"] == []
        assert summary["orphanCount"] == 0

    def test_an_unavailable_entity_without_a_twin_is_an_orphan_not_a_duplicate(self):
        """Only a dead entity with a live replacement is safe to delete. A lone
        unavailable entity may be broken hardware or just a sleeping device, so
        it is reported separately and never as safe-to-delete."""
        states = [
            row("sensor.attic_probe_temperature", "unavailable", name="Attic probe"),
            row("binary_sensor.basement_water_leak", "off", name="Basement water leak"),
            row("binary_sensor.basement_water_leak_6", "unavailable", name="Basement water leak"),
        ]
        summary = home_health.registry_summary(states)
        assert summary["orphans"] == [{"entityId": "sensor.attic_probe_temperature", "name": "Attic probe"}]
        assert summary["orphanCount"] == 1
        assert [item["entityId"] for item in summary["duplicates"]] == ["binary_sensor.basement_water_leak_6"]
        assert summary["unavailable"] == 2

    def test_an_unknown_state_counts_as_neither_live_nor_unavailable(self):
        # `unknown` is a sensor that has not reported yet, not a dead one, so it
        # must not pad the safe-to-delete list.
        states = [row("sensor.new_probe_temperature", "unknown", name="New probe")]
        summary = home_health.registry_summary(states)
        assert (summary["total"], summary["live"], summary["unavailable"]) == (1, 0, 0)
        assert summary["duplicates"] == []
        assert summary["orphans"] == []

    def test_the_orphan_list_is_capped_but_the_count_is_not(self):
        """The panel shows a list; the count has to stay truthful even when the
        list is truncated."""
        states = [row(f"sensor.dead_{index}_temperature", "unavailable") for index in range(130)]
        summary = home_health.registry_summary(states)
        assert len(summary["orphans"]) == 120
        assert summary["orphanCount"] == 130

    def test_an_empty_install_is_survived(self):
        summary = home_health.registry_summary([])
        assert summary["total"] == 0
        assert summary["live"] == 0
        assert summary["duplicates"] == []


class TestHealthSummary:
    def test_the_shape_is_items_counts_and_registry(self):
        states = [
            row("light.kitchen", "on"),
            *healthy_backup(),
        ]
        summary = home_health.health_summary(states, now=BASE)
        assert set(summary) == {"items", "counts", "registry"}
        assert summary["items"] == []
        assert summary["counts"] == {"critical": 0, "warning": 0, "info": 0}
        assert summary["registry"]["total"] == 3

    def test_counts_match_the_severities_present(self):
        states = [
            row("binary_sensor.basement_water_leak", "on", device_class="moisture", name="Basement leak"),
            row("sensor.hall_sensor_battery", 18, device_class="battery", unit="%", name="Hall battery"),
            row("update.some_addon", "on", name="Some add-on"),
            row("sensor.backup_last_successful_automatic_backup", stamp(81 * DAY)),
            row("sensor.backup_last_attempted_automatic_backup", stamp(2 * HOUR)),
        ]
        summary = home_health.health_summary(states, now=BASE)
        assert summary["counts"] == {"critical": 2, "warning": 1, "info": 1}
        assert sum(summary["counts"].values()) == len(summary["items"])

    def test_the_registry_travels_with_the_summary(self):
        states = [
            row("binary_sensor.basement_water_leak", "off", name="Basement water leak"),
            row("binary_sensor.basement_water_leak_6", "unavailable", name="Basement water leak"),
        ]
        summary = home_health.health_summary(states, now=BASE)
        assert summary["registry"]["duplicates"][0]["replacedBy"] == "binary_sensor.basement_water_leak"
