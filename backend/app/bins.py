"""Bin night: when the trash (and every other week, recycling) goes out, and the reminders for it.

The household sets the pickup weekday, whether recycling is weekly, fortnightly or not collected,
one date recycling was or will be collected (which fixes which weeks are recycling weeks), and the
evening window for reminders. On the evening before pickup, a reminder is due every
`interval_minutes` from `remind_start` until `remind_end`; on pickup morning, until 10 am, the
dashboard asks once more. Tapping "Bins are out" marks that pickup done and silences both.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any

from .atomic import write_text_atomic
from .storage import data_file

logger = logging.getLogger(__name__)

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
PICKUP_MORNING_UNTIL = time(10, 0)
_CLOCK = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class BinSchedule:
    enabled: bool = True
    trash_weekday: int = 3  # Thursday
    recycling: str = "biweekly"  # "biweekly", "weekly" or "none"
    # A Thursday that was (or will be) a recycling pickup; fortnightly weeks count from it.
    recycling_anchor: date | None = date(2026, 11, 19)
    remind_start: time = time(16, 0)
    remind_end: time = time(22, 0)
    interval_minutes: int = 30


def _clock(value: Any, default: time) -> time:
    match = _CLOCK.match(value) if isinstance(value, str) else None
    return time(int(match.group(1)), int(match.group(2))) if match else default


def schedule_from_overrides(overrides: dict[str, Any]) -> BinSchedule:
    raw = overrides.get("binSchedule")
    if not isinstance(raw, dict):
        return BinSchedule()
    default = BinSchedule()
    weekday = raw.get("trashWeekday")
    interval = raw.get("intervalMinutes")
    anchor = default.recycling_anchor
    if isinstance(raw.get("recyclingAnchorDate"), str):
        try:
            anchor = date.fromisoformat(raw["recyclingAnchorDate"])
        except ValueError:
            pass
    return BinSchedule(
        enabled=raw.get("enabled") if isinstance(raw.get("enabled"), bool) else default.enabled,
        trash_weekday=weekday if isinstance(weekday, int) and 0 <= weekday <= 6 else default.trash_weekday,
        recycling=raw.get("recycling") if raw.get("recycling") in ("biweekly", "weekly", "none") else default.recycling,
        recycling_anchor=anchor,
        remind_start=_clock(raw.get("remindStart"), default.remind_start),
        remind_end=_clock(raw.get("remindEnd"), default.remind_end),
        interval_minutes=interval if isinstance(interval, int) and 10 <= interval <= 180 else default.interval_minutes,
    )


def schedule_as_dict(schedule: BinSchedule) -> dict[str, Any]:
    return {
        "enabled": schedule.enabled,
        "trashWeekday": schedule.trash_weekday,
        "recycling": schedule.recycling,
        "recyclingAnchorDate": schedule.recycling_anchor.isoformat() if schedule.recycling_anchor else None,
        "remindStart": schedule.remind_start.strftime("%H:%M"),
        "remindEnd": schedule.remind_end.strftime("%H:%M"),
        "intervalMinutes": schedule.interval_minutes,
    }


def collection_on_or_after(day: date, schedule: BinSchedule) -> tuple[date, list[str]]:
    """The first pickup on or after `day`, and what goes out: trash, plus recycling on its weeks."""
    pickup = day + timedelta(days=(schedule.trash_weekday - day.weekday()) % 7)
    kinds = ["trash"]
    if schedule.recycling == "weekly":
        kinds.append("recycling")
    elif schedule.recycling == "biweekly" and schedule.recycling_anchor is not None:
        if (pickup - schedule.recycling_anchor).days % 14 == 0:
            kinds.append("recycling")
    return pickup, kinds


def _what(kinds: list[str]) -> str:
    return "Trash and recycling" if "recycling" in kinds else "Trash"


def status(now: datetime, schedule: BinSchedule, done_for: date | None) -> dict[str, Any]:
    """The next pickup and whether a reminder is due right now. `now` is the household's local time."""
    today = now.date()
    pickup, kinds = collection_on_or_after(today, schedule)
    # Once pickup morning is over, the next pickup is the one to talk about.
    if pickup == today and now.time() >= PICKUP_MORNING_UNTIL:
        pickup, kinds = collection_on_or_after(today + timedelta(days=1), schedule)
    done = done_for == pickup
    phase: str | None = None
    slot: int | None = None
    title = message = None
    if schedule.enabled and not done:
        if pickup == today + timedelta(days=1) and schedule.remind_start <= now.time() < schedule.remind_end:
            phase = "evening"
            start = datetime.combine(today, schedule.remind_start, now.tzinfo)
            slot = int((now - start).total_seconds() // 60) // schedule.interval_minutes
            title = f"{_what(kinds)} out tonight"
            message = f"{_what(kinds)} pickup is tomorrow morning. Take the {' and '.join(kinds)} bins to the curb."
        elif pickup == today and now.time() < PICKUP_MORNING_UNTIL:
            phase = "morning"
            title = f"{_what(kinds)} pickup this morning"
            message = "Are the bins at the curb?"
    days_away = (pickup - today).days
    return {
        "enabled": schedule.enabled,
        "pickupDate": pickup.isoformat(),
        "pickupLabel": "Today" if days_away == 0 else "Tomorrow" if days_away == 1 else WEEKDAYS[pickup.weekday()],
        "kinds": kinds,
        "done": done,
        "phase": phase,
        "slot": slot,
        "title": title,
        "message": message,
    }


# --- "Bins are out" -----------------------------------------------------------------


def _state_path():
    return data_file("bins-state.json")


def load_done_for() -> date | None:
    path = _state_path()
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text()).get("doneFor")
        return date.fromisoformat(value) if isinstance(value, str) else None
    except (OSError, ValueError, AttributeError) as error:
        logger.warning("Could not read bin reminder state: %s", error)
        return None


def save_done_for(value: date | None) -> None:
    write_text_atomic(_state_path(), json.dumps({"doneFor": value.isoformat() if value else None}))
