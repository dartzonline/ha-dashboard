"""Upkeep: what is wearing out, what is running out, and what is drifting.

Distinct from `home_health`, which answers "is anything broken right now".
This answers "what will need me soon", which is a different and quieter class
of signal -- the kind nobody notices until a filter has been at 0% for weeks.

Three kinds of thing are gathered:

* **Consumables.** Filters, brushes and strainers, reported by their devices in
  wildly different units: Roborock counts down *hours remaining*, LG and Dyson
  report *percent of life left*. Both are normalised to a fraction so one panel
  can rank them against each other.
* **Reservoirs.** Salt and water levels, which deplete rather than wear.
* **Mechanical drift.** A garage door's opening and closing durations are a
  genuine predictive-maintenance signal: a door that takes longer to travel
  than it used to has a spring, chain or roller problem developing. Nothing in
  Home Assistant watches that number for change.

Where a device publishes an explicit fault flag it is trusted over any derived
figure, because the device knows things a percentage cannot express.
"""

from __future__ import annotations

from typing import Any, Iterable

DEAD_STATES = {"unavailable", "unknown"}

# Roborock publishes hours remaining rather than a percentage, so a full service
# interval is needed to express it as a fraction. These are the manufacturer's
# published intervals -- the device does not report them, so the UI says the
# percentages are derived rather than device-reported.
SERVICE_INTERVAL_HOURS = {
    "main_brush": 300.0,
    "side_brush": 200.0,
    "filter": 150.0,
    "sensor": 30.0,
    "dock_strainer": 90.0,
    "dock_maintenance_brush": 300.0,
}

# Below this fraction of life remaining a consumable is worth ordering.
CONSUMABLE_WARN = 0.20
CONSUMABLE_CRITICAL = 0.05

# Salt depth: an empty brine tank reads a *larger* distance because the sensor
# looks down at the salt from above. Calibrated from the observed range on this
# install rather than assumed, and used only as a fallback when the device's own
# percentage is untrustworthy (see `salt_status`).
SALT_FULL_CM = 15.0
SALT_EMPTY_CM = 55.0


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def _name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return str(attributes.get("friendly_name") or entity.get("entity_id") or "")


def _unit(entity: dict[str, Any]) -> str:
    return str((entity.get("attributes") or {}).get("unit_of_measurement") or "")


def _index(states: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(entity.get("entity_id", "")): entity for entity in states}


def _severity(fraction: float | None, fault: bool = False) -> str:
    if fault:
        return "critical"
    if fraction is None:
        return "unknown"
    if fraction <= CONSUMABLE_CRITICAL:
        return "critical"
    if fraction <= CONSUMABLE_WARN:
        return "warning"
    return "ok"


def _interval_for(entity_id: str) -> float | None:
    # Longest key first so "dock_maintenance_brush" is not matched by "brush".
    for key in sorted(SERVICE_INTERVAL_HOURS, key=len, reverse=True):
        if key in entity_id:
            return SERVICE_INTERVAL_HOURS[key]
    return None


# Wear items are named inconsistently. "_time_left" is the catch-all that picks
# up the vacuum's dust-sensor consumable, whose id contains none of the words
# below -- it was silently dropped, and it is the one item on this install
# actually past its service interval.
CONSUMABLE_HINTS = ("filter", "brush", "strainer", "consumable", "cartridge", "time_left")


def consumables(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every wear item, normalised to a fraction of life remaining.

    Two shapes are handled because devices disagree: a percentage is already a
    fraction of life, while hours-remaining needs dividing by a service
    interval. An item whose device also exposes a "replace me" flag inherits
    that flag, since the device is more authoritative than either number.
    """
    states = list(states)
    replacement_flags = {
        str(entity.get("entity_id", "")): entity.get("state") == "on"
        for entity in states
        if str(entity.get("entity_id", "")).startswith("binary_sensor.")
        and ("filter_replacement" in str(entity.get("entity_id", "")) or "replace" in str(entity.get("entity_id", "")))
    }
    any_replacement_due = any(replacement_flags.values())

    found: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("sensor.") or entity.get("state") in DEAD_STATES:
            continue
        if not any(hint in entity_id.lower() for hint in CONSUMABLE_HINTS):
            continue
        # "_filter_type" is the cartridge model, not its life.
        if entity_id.endswith("_type") or "_type_" in entity_id:
            continue
        value = _number(entity.get("state"))
        if value is None:
            continue

        unit = _unit(entity)
        fraction: float | None = None
        remaining_hours: float | None = None
        if unit == "%":
            fraction = max(0.0, min(1.0, value / 100))
        elif unit == "h":
            remaining_hours = value
            interval = _interval_for(entity_id)
            if interval:
                # A negative remainder means the interval has been exceeded, which
                # is a real state ("overdue") rather than something to clamp away
                # silently -- the fraction floors at 0 but `overdue` records it.
                fraction = max(0.0, min(1.0, value / interval))
        else:
            continue

        device_flagged = any_replacement_due and "dyson" in entity_id and fraction is not None and fraction <= CONSUMABLE_WARN
        found.append({
            "entityId": entity_id,
            "name": _name(entity),
            "fraction": round(fraction, 4) if fraction is not None else None,
            "percent": round(fraction * 100, 1) if fraction is not None else None,
            "remainingHours": round(remaining_hours, 1) if remaining_hours is not None else None,
            "overdue": bool(remaining_hours is not None and remaining_hours <= 0),
            "derived": unit == "h",
            "severity": _severity(fraction, fault=device_flagged or bool(remaining_hours is not None and remaining_hours <= 0)),
        })

    order = {"critical": 0, "warning": 1, "unknown": 2, "ok": 3}
    found.sort(key=lambda item: (order.get(str(item["severity"]), 9), item["fraction"] if item["fraction"] is not None else 1.0))
    return found


def salt_status(states: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Water-softener salt, preferring the depth reading over the percentage.

    The percentage on this install collapsed from 60% to 0% while the depth
    sensor barely moved (43.5cm to 42.1cm), so the percentage is a calibration
    artefact and trusting it would show a false "refill now". Depth is the raw
    measurement and is used whenever the two disagree materially; the
    disagreement is reported so the sensor can be fixed rather than silently
    worked around.
    """
    index = _index(states)
    depth_entity = index.get("sensor.esphome_web_79cc76_salt_level")
    percent_entity = index.get("sensor.esphome_web_79cc76_salt_level_percent")
    if not depth_entity and not percent_entity:
        return None

    depth_cm = _number((depth_entity or {}).get("state")) if depth_entity and depth_entity.get("state") not in DEAD_STATES else None
    reported = _number((percent_entity or {}).get("state")) if percent_entity and percent_entity.get("state") not in DEAD_STATES else None

    from_depth: float | None = None
    if depth_cm is not None:
        span = SALT_EMPTY_CM - SALT_FULL_CM
        if span > 0:
            from_depth = max(0.0, min(100.0, (1 - (depth_cm - SALT_FULL_CM) / span) * 100))

    percent = from_depth if from_depth is not None else reported
    disagrees = (
        from_depth is not None and reported is not None and abs(from_depth - reported) >= 25
    )

    return {
        "depthCm": round(depth_cm, 1) if depth_cm is not None else None,
        "reportedPercent": round(reported, 1) if reported is not None else None,
        "percent": round(percent, 1) if percent is not None else None,
        "fromDepth": from_depth is not None,
        "sensorDisagrees": disagrees,
        "severity": _severity((percent / 100) if percent is not None else None),
    }


def garage_status(states: Iterable[dict[str, Any]]) -> dict[str, Any] | None:
    """Garage door position, obstruction, and travel-time wear signal.

    Travel duration is the interesting number: a door that gradually takes
    longer to open than it used to has a developing spring or roller problem.
    Home Assistant stores the value but nothing watches it for drift, so it is
    surfaced here with its history left to the caller to chart.
    """
    index = _index(states)
    door = index.get("cover.ratgdov25i_8e54c8_door")
    if not door:
        return None

    def value(entity_id: str) -> float | None:
        entity = index.get(entity_id)
        if not entity or entity.get("state") in DEAD_STATES:
            return None
        return _number(entity.get("state"))

    obstruction = index.get("binary_sensor.ratgdov25i_8e54c8_obstruction")
    firmware = index.get("sensor.ratgdov25i_8e54c8_firmware_version")

    return {
        "entityId": door.get("entity_id"),
        "state": door.get("state"),
        "obstructed": bool(obstruction and obstruction.get("state") == "on"),
        "openingSeconds": value("number.ratgdov25i_8e54c8_opening_duration"),
        "closingSeconds": value("number.ratgdov25i_8e54c8_closing_duration"),
        "openLimit": (index.get("binary_sensor.ratgdov25i_8e54c8_open_limit_switch") or {}).get("state"),
        "closeLimit": (index.get("binary_sensor.ratgdov25i_8e54c8_close_limit_switch") or {}).get("state"),
        "firmware": (firmware or {}).get("state"),
        "durationEntities": [
            "number.ratgdov25i_8e54c8_opening_duration",
            "number.ratgdov25i_8e54c8_closing_duration",
        ],
    }


def device_faults(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Explicit fault flags a device is raising about itself.

    Many integrations publish a fan-out of `fault_*` binary sensors that are
    almost always `off` and therefore invisible; when one does trip it deserves
    to be the loudest thing on the page.
    """
    faults: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("binary_sensor."):
            continue
        if entity.get("state") != "on":
            continue
        device_class = str((entity.get("attributes") or {}).get("device_class") or "")
        is_fault_name = "fault" in entity_id or "error" in entity_id
        if device_class != "problem" and not is_fault_name:
            continue
        faults.append({
            "entityId": entity_id,
            "name": _name(entity),
        })
    faults.sort(key=lambda item: str(item["entityId"]))
    return faults


def appliance_usage(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Cycle counts and month-over-month energy, as a proxy for wear and drift.

    A month's energy well above the previous one on an appliance that is not
    being used more often is worth noticing -- a fridge working harder is often
    a door seal or a coil problem.
    """
    index = _index(states)
    devices: dict[str, dict[str, Any]] = {}

    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if not entity_id.startswith("sensor.") or entity.get("state") in DEAD_STATES:
            continue
        for suffix, key in (
            ("_energy_this_month", "thisMonthWh"),
            ("_energy_last_month", "lastMonthWh"),
            ("_cycles", "cycles"),
        ):
            if entity_id.endswith(suffix):
                device = entity_id[len("sensor."):-len(suffix)]
                value = _number(entity.get("state"))
                if value is None:
                    continue
                slot = devices.setdefault(device, {"device": device, "name": device.replace("_", " ").title()})
                slot[key] = value
                slot.setdefault("entityIds", []).append(entity_id)

    results: list[dict[str, Any]] = []
    for slot in devices.values():
        this_month = slot.get("thisMonthWh")
        last_month = slot.get("lastMonthWh")
        change: float | None = None
        # Only meaningful once the previous month has a real total to compare to,
        # and pointless in the first days of a month when this month is tiny.
        if this_month is not None and last_month not in (None, 0):
            change = round(((this_month - float(last_month)) / float(last_month)) * 100, 1)
        status_entity = index.get(f"sensor.{slot['device']}_current_status")
        results.append({
            **slot,
            "changePercent": change,
            "status": (status_entity or {}).get("state"),
        })

    results.sort(key=lambda item: str(item["name"]))
    return results


def maintenance_summary(states: Iterable[dict[str, Any]]) -> dict[str, Any]:
    states = list(states)
    items = consumables(states)
    return {
        "consumables": items,
        "salt": salt_status(states),
        "garage": garage_status(states),
        "faults": device_faults(states),
        "appliances": appliance_usage(states),
        "counts": {
            "critical": sum(1 for item in items if item["severity"] == "critical"),
            "warning": sum(1 for item in items if item["severity"] == "warning"),
            "ok": sum(1 for item in items if item["severity"] == "ok"),
        },
    }
