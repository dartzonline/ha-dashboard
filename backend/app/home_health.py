"""Whole-home health: what needs attention, and what has quietly stopped working.

Home Assistant is good at showing the *current* value of a sensor and bad at
noticing when a sensor stops being truthful. Three failure modes go unreported
by design, and each one was found in real data on this install:

* **Stale sensors.** A value that has not changed in far longer than its own
  cadence is almost certainly frozen, not stable. A lawn-moisture sensor here
  had been reporting `0%` for a week while its neighbour updated normally --
  Home Assistant flags nothing, because `0` is a perfectly valid number.
* **Silent task failure.** Automatic backups had been attempted daily and
  failing for 81 days: `last_attempted` was today, `last_successful` was in
  May. Both sensors were "fine"; only the gap between them was the problem.
* **Duplicate registrations.** Re-pairing a device leaves the old entities
  behind as permanently `unavailable`, next to a working twin. They inflate
  every entity count and make a real dead device impossible to spot.

Everything here reads only entity state and history that the dashboard already
fetches, so nothing new is polled to produce it.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterable

DEAD_STATES = {"unavailable", "unknown"}

# Battery percentage below which a cell is worth replacing soon. Chosen low
# enough that it does not nag: most sensors run for months in the 40-100 band.
BATTERY_WARN_PERCENT = 25.0
BATTERY_CRITICAL_PERCENT = 12.0

# A consumable (filter, brush) below this fraction of life remaining.
CONSUMABLE_WARN_PERCENT = 12.0

# A sensor unchanged for this long is suspected frozen rather than steady. A day
# is deliberately generous: a shorter window turns every Home Assistant restart
# into a wall of false warnings, because a restart rewrites `last_changed` on
# hundreds of entities at once and they then all "freeze" together until their
# next real reading.
STALE_AFTER_S = 24 * 3600.0

# Entities sharing one `last_changed` to the minute in this quantity did not all
# freeze simultaneously -- Home Assistant restarted. Their age measures uptime,
# not staleness, so they are skipped rather than reported.
RESTART_BURST_MIN = 12

# ...but only up to a point. A sensor that has not moved since a restart days ago
# really has stopped, whatever caused the timestamp: a live sensor produces a new
# reading within minutes of coming back. This is the threshold that keeps the
# genuinely-frozen lawn-moisture sensor visible (unchanged since a restart eight
# days ago, reporting `0%`) while still ignoring the restart that happened today.
RESTART_BURST_GRACE_S = 36 * 3600.0

# Sensors whose value legitimately holds still for a long time, so staleness
# means nothing. Matched as substrings against the entity id.
STALE_EXEMPT = (
    "_battery_type", "_firmware", "_version", "_ssid", "_bssid", "_ip",
    "_mac", "_serial", "_model", "_next_", "_last_", "_type", "_status",
    "_state", "_mode", "_identify", "_restart", "_reboot", "_update",
    "sun_next", "backup_", "_energy_last_month", "_cycles",
)

# Domains where a frozen value is normal (a switch stays off for weeks).
STALE_DOMAINS = {"sensor"}

# Only these classes are expected to keep moving, so only these are judged for
# staleness. Batteries and coin-cell voltages sit at a flat 100%/3.0V for months
# when perfectly healthy -- treating those as frozen produced 110 warnings here
# and buried the four findings that actually mattered. Consumable wear and
# cumulative totals are likewise legitimately still for long stretches.
STALE_CLASSES = {
    "temperature", "humidity", "illuminance", "pressure", "atmospheric_pressure",
    "moisture", "carbon_dioxide", "carbon_monoxide", "pm25", "pm10", "aqi",
    "power", "current", "data_rate", "speed", "wind_speed", "precipitation_intensity",
}


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _parse_time(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None  # reject NaN


def _name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return str(attributes.get("friendly_name") or entity.get("entity_id") or "")


def _domain(entity: dict[str, Any]) -> str:
    return str(entity.get("entity_id", "")).split(".", 1)[0]


def _device_class(entity: dict[str, Any]) -> str:
    return str((entity.get("attributes") or {}).get("device_class") or "")


def stale_sensors(states: Iterable[dict[str, Any]], now: float | None = None) -> list[dict[str, Any]]:
    """Numeric sensors whose value has not moved in an implausibly long time.

    This is the check that catches a sensor reporting a plausible-looking value
    it froze on. Only numeric sensors are considered -- a text or enum sensor
    holding one state for days is ordinary.
    """
    moment = now if now is not None else _now()
    states = list(states)

    # Timestamps shared by many entities are restart artefacts, not evidence
    # that all of them stopped reporting at the same instant.
    crowd: dict[str, int] = {}
    for entity in states:
        stamp = str(entity.get("last_changed") or "")[:16]
        if stamp:
            crowd[stamp] = crowd.get(stamp, 0) + 1

    found: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if _domain(entity) not in STALE_DOMAINS:
            continue
        if entity.get("state") in DEAD_STATES:
            continue
        if any(token in entity_id for token in STALE_EXEMPT):
            continue
        if _device_class(entity) not in STALE_CLASSES:
            continue
        if _number(entity.get("state")) is None:
            continue

        changed = _parse_time(entity.get("last_changed"))
        if changed is None:
            continue
        age = moment - changed
        if age < STALE_AFTER_S:
            continue
        in_burst = crowd.get(str(entity.get("last_changed") or "")[:16], 0) >= RESTART_BURST_MIN
        if in_burst and age < RESTART_BURST_GRACE_S:
            continue
        found.append({
            "entityId": entity_id,
            "name": _name(entity),
            "state": entity.get("state"),
            "unit": (entity.get("attributes") or {}).get("unit_of_measurement"),
            "staleSeconds": round(age),
        })
    found.sort(key=lambda item: item["staleSeconds"], reverse=True)
    return found


def _severity_rank(severity: str) -> int:
    return {"critical": 0, "warning": 1, "info": 2}.get(severity, 3)


def attention_items(states: Iterable[dict[str, Any]], now: float | None = None) -> list[dict[str, Any]]:
    """Everything that plausibly wants a human, newest concern first.

    Deliberately conservative: an item appears only when there is a concrete
    reason, because a panel that cries wolf gets ignored and then the one real
    problem in it goes unread too.
    """
    moment = now if now is not None else _now()
    states = list(states)
    items: list[dict[str, Any]] = []

    def add(severity: str, category: str, title: str, detail: str, entity_id: str | None = None) -> None:
        items.append({
            "severity": severity,
            "category": category,
            "title": title,
            "detail": detail,
            "entityId": entity_id,
        })

    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        state = str(entity.get("state", ""))
        device_class = _device_class(entity)
        attributes = entity.get("attributes") or {}

        # Active problem sensors: the integration itself is saying something is wrong.
        if device_class == "problem" and state == "on":
            add("warning", "problem", _name(entity), "Reported a problem", entity_id)

        # Low batteries, split so a dying cell outranks a merely low one.
        elif device_class == "battery" and _domain(entity) == "sensor":
            level = _number(state)
            if level is not None and level <= BATTERY_WARN_PERCENT:
                severity = "critical" if level <= BATTERY_CRITICAL_PERCENT else "warning"
                add(severity, "battery", _name(entity), f"Battery at {level:g}%", entity_id)

        # Pending updates.
        elif _domain(entity) == "update" and state == "on":
            installed = attributes.get("installed_version")
            latest = attributes.get("latest_version")
            detail = f"{installed} → {latest}" if installed and latest else "Update available"
            add("info", "update", _name(entity), detail, entity_id)

        # Doors and windows left open.
        elif device_class in ("door", "window", "garage_door", "opening") and state == "on":
            add("info", "opening", _name(entity), "Open", entity_id)

        # Water leaks and smoke are the only things here worth shouting about.
        elif device_class in ("moisture", "smoke", "gas", "safety") and state == "on":
            add("critical", "safety", _name(entity), "Detected", entity_id)

    items += _backup_items(states, moment)
    items += _consumable_items(states)

    for entity in stale_sensors(states, moment):
        hours = entity["staleSeconds"] / 3600
        label = f"{hours:.0f}h" if hours < 48 else f"{hours / 24:.0f}d"
        add(
            "warning",
            "stale",
            entity["name"],
            f"Unchanged for {label} — reading {entity['state']}{entity['unit'] or ''}",
            entity["entityId"],
        )

    items.sort(key=lambda item: (_severity_rank(str(item["severity"])), str(item["category"]), str(item["title"])))
    return items


def _backup_items(states: Iterable[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    """Backups that are running but not succeeding.

    Both sensors read as healthy individually; the failure is only visible in
    the distance between the last attempt and the last success. This install had
    been attempting a backup every day for 81 days without one completing.
    """
    by_id = {str(entity.get("entity_id", "")): entity for entity in states}
    last_ok = by_id.get("sensor.backup_last_successful_automatic_backup")
    if not last_ok:
        return []
    succeeded = _parse_time(last_ok.get("state"))
    if succeeded is None:
        return [{
            "severity": "critical",
            "category": "backup",
            "title": "Automatic backup",
            "detail": "No successful backup on record",
            "entityId": last_ok.get("entity_id"),
        }]

    days = (now - succeeded) / 86400
    if days < 3:
        return []

    attempted = _parse_time((by_id.get("sensor.backup_last_attempted_automatic_backup") or {}).get("state"))
    tried_since = attempted is not None and attempted > succeeded
    detail = f"Last succeeded {days:.0f} days ago"
    if tried_since:
        detail += " — attempts since then have failed"
    return [{
        "severity": "critical" if days >= 7 else "warning",
        "category": "backup",
        "title": "Automatic backup",
        "detail": detail,
        "entityId": last_ok.get("entity_id"),
    }]


# Consumables expose "life remaining" as a percentage; the words vary by brand.
CONSUMABLE_HINTS = ("filter", "brush", "consumable", "cartridge")


def _consumable_items(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for entity in states:
        entity_id = str(entity.get("entity_id", ""))
        if _domain(entity) != "sensor" or entity.get("state") in DEAD_STATES:
            continue
        attributes = entity.get("attributes") or {}
        if attributes.get("unit_of_measurement") != "%":
            continue
        if _device_class(entity) == "battery":
            continue
        if not any(hint in entity_id.lower() for hint in CONSUMABLE_HINTS):
            continue
        level = _number(entity.get("state"))
        if level is None or level > CONSUMABLE_WARN_PERCENT:
            continue
        items.append({
            "severity": "warning" if level > 0 else "critical",
            "category": "consumable",
            "title": _name(entity),
            "detail": "Needs replacing" if level <= 0 else f"{level:g}% life left",
            "entityId": entity_id,
        })
    return items


# Trailing "_2", "_3" ... that Home Assistant appends when an entity id collides
# with one that already exists -- the signature of a re-registered device.
_SUFFIX = re.compile(r"_(\d+)$")


def duplicate_entities(states: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Permanently-unavailable entities that have a working twin.

    Re-pairing a device leaves its old entities behind forever, and Home
    Assistant keeps counting them. Pairing each dead entity with the live one
    that replaced it is what makes them safe to delete: without the twin you
    cannot tell a stale duplicate from genuinely broken hardware.
    """
    states = list(states)
    live_names: dict[str, list[str]] = {}
    for entity in states:
        if entity.get("state") in DEAD_STATES:
            continue
        live_names.setdefault(_name(entity).strip().lower(), []).append(str(entity.get("entity_id")))

    findings: list[dict[str, Any]] = []
    for entity in states:
        if entity.get("state") != "unavailable":
            continue
        entity_id = str(entity.get("entity_id", ""))
        domain, _, object_id = entity_id.partition(".")

        twin: str | None = None
        # A numeric suffix means the base id was taken -- by the entity that
        # replaced this one.
        match = _SUFFIX.search(object_id)
        if match:
            base = f"{domain}.{object_id[: match.start()]}"
            candidate = next(
                (item for item in states
                 if str(item.get("entity_id")) == base and item.get("state") not in DEAD_STATES),
                None,
            )
            if candidate:
                twin = base
        if twin is None:
            # Otherwise fall back to an identically-named live entity, which is
            # how a rename-and-repair shows up. Only when the name is unique
            # among live entities: two unrelated devices can both be called
            # something generic ("Battery"), and pairing off that would list an
            # unrelated entity as safe to delete -- the one outcome here that
            # would actually lose data.
            candidates = [
                candidate_id
                for candidate_id in live_names.get(_name(entity).strip().lower(), [])
                if candidate_id != entity_id and candidate_id.startswith(f"{domain}.")
            ]
            if len(candidates) == 1:
                twin = candidates[0]
        if twin:
            findings.append({
                "entityId": entity_id,
                "name": _name(entity),
                "replacedBy": twin,
            })

    findings.sort(key=lambda item: str(item["entityId"]))
    return findings


def registry_summary(states: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Counts that make the entity list honest, plus the safe-to-delete list."""
    states = list(states)
    duplicates = duplicate_entities(states)
    duplicate_ids = {item["entityId"] for item in duplicates}
    unavailable = [entity for entity in states if entity.get("state") == "unavailable"]

    # Unavailable with no live twin: either genuinely broken hardware or a
    # device that is simply asleep. Worth showing separately from the
    # definitely-safe-to-delete duplicates.
    orphans = [
        {"entityId": str(entity.get("entity_id")), "name": _name(entity)}
        for entity in unavailable
        if str(entity.get("entity_id")) not in duplicate_ids
    ]
    orphans.sort(key=lambda item: item["entityId"])

    return {
        "total": len(states),
        "live": sum(1 for entity in states if entity.get("state") not in DEAD_STATES),
        "unavailable": len(unavailable),
        "duplicates": duplicates,
        "orphans": orphans[:120],
        "orphanCount": len(orphans),
    }


def health_summary(states: Iterable[dict[str, Any]], now: float | None = None) -> dict[str, Any]:
    states = list(states)
    items = attention_items(states, now)
    counts: dict[str, int] = {"critical": 0, "warning": 0, "info": 0}
    for item in items:
        severity = str(item["severity"])
        counts[severity] = counts.get(severity, 0) + 1
    return {
        "items": items,
        "counts": counts,
        "registry": registry_summary(states),
    }
