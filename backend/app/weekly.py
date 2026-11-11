"""The weekly house report: what house watch saw this week, against the week before."""

from __future__ import annotations

from collections import Counter
from typing import Any

DAY = 86400.0
WEEK = 7 * DAY
LIGHT_RULES = {"light_left_on", "outdoor_light_day"}


def _in(entry_at: float, start: float, end: float) -> bool:
    return start <= entry_at < end


def _count(entries: list[dict[str, Any]], test) -> int:
    return sum(1 for entry in entries if test(entry))


def _hours(entries: list[dict[str, Any]], test, now: float) -> float:
    return sum(((entry.get("endedAt") or now) - entry["startedAt"]) / 3600 for entry in entries if test(entry))


def weekly_report(journal: list[dict[str, Any]], actions: list[dict[str, Any]], now: float) -> dict[str, Any]:
    """`journal` entries carry float `startedAt`/`endedAt`; `actions` carry a float `at`."""
    this_start, last_start = now - WEEK, now - 2 * WEEK
    this = [entry for entry in journal if _in(entry["startedAt"], this_start, now)]
    last = [entry for entry in journal if _in(entry["startedAt"], last_start, this_start)]
    this_actions = [action for action in actions if _in(action["at"], this_start, now)]
    last_actions = [action for action in actions if _in(action["at"], last_start, this_start)]

    def is_light(entry):
        return entry["rule"] in LIGHT_RULES or (entry["rule"] == "away_and_on" and entry["entityId"].startswith("light."))

    def after_dark(rule):
        return lambda entry: entry["rule"] == rule and "after dark" in str(entry.get("detail", ""))

    def is_open_after_dark(entry):
        return entry["rule"] == "open_after_dark"

    def is_kitchen(entry):
        return entry["rule"] in ("oven_on", "fridge_warm")

    stats = [
        {"key": "noticed", "label": "Things noticed", "value": len(this), "previous": len(last)},
        {"key": "lights", "label": "Lights left on", "value": _count(this, is_light), "previous": _count(last, is_light),
         "detail": f"{_hours(this, is_light, now):.0f} h in all"},
        {"key": "autoOff", "label": "Switched off for you", "value": len(this_actions), "previous": len(last_actions)},
        {"key": "garage", "label": "Garage open after dark", "value": _count(this, after_dark("garage_open")), "previous": _count(last, after_dark("garage_open"))},
        {"key": "locks", "label": "Unlocked after dark", "value": _count(this, after_dark("lock_unlocked")), "previous": _count(last, after_dark("lock_unlocked"))},
        {"key": "openings", "label": "Doors and windows open after dark", "value": _count(this, is_open_after_dark), "previous": _count(last, is_open_after_dark)},
        {"key": "kitchen", "label": "Oven and fridge alerts", "value": _count(this, is_kitchen), "previous": _count(last, is_kitchen)},
    ]
    top = [
        {"name": name, "count": count}
        for name, count in Counter(entry["name"] for entry in this).most_common(3)
    ]
    if not this:
        headline = "A quiet week: nothing needed attention."
    elif len(this) < len(last):
        headline = f"A calmer week: {len(this)} things noticed, down from {len(last)}."
    elif len(this) > len(last) and last:
        headline = f"A busier week: {len(this)} things noticed, up from {len(last)}."
    else:
        headline = f"{len(this)} thing{'s' if len(this) != 1 else ''} noticed this week."
    return {"headline": headline, "stats": stats, "top": top, "days": 7}


def summary_text(report: dict[str, Any]) -> str:
    """One notification's worth: the headline and the non-zero numbers."""
    parts = [f"{stat['label']}: {stat['value']}" for stat in report["stats"][1:] if stat["value"]]
    return report["headline"] + (" " + " · ".join(parts) if parts else "")
