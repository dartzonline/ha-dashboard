"""Household routines learned from a door sensor, and whether today's has happened.

This house's patio door opens in three clear bursts a day (about 7 am, 4 pm and 10 pm). Rather than
ask anyone to describe that, the routine is read from the sensor's own history: openings that
happen close together are one *visit*, and a time of day that has a visit on at least half the
recent days (and at least four of them) is a *routine*. Today is then checked against each
routine, and a routine that has not happened half an hour after its usual time is *late* -- the
cue for "the 10 pm patio door trip hasn't happened".

Pure functions over (epoch, state) points, so everything here is testable without Home Assistant.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta, tzinfo
from typing import Any, Iterable

VISIT_GAP_S = 20 * 60.0
SLOT_GAP_MIN = 75
MIN_DAYS = 4
MIN_SHARE = 0.5
MATCH_BEFORE_MIN = 90
LATE_AFTER_MIN = 30
WINDOW_DAYS = 14
OPEN_STATES = {"on"}
CLOSED_STATES = {"off"}


@dataclass(frozen=True)
class Visit:
    start: datetime
    end: datetime

    @property
    def minute(self) -> int:
        return self.start.hour * 60 + self.start.minute


def visits_from_points(points: Iterable[tuple[float, str]], zone: tzinfo) -> list[Visit]:
    """Openings grouped into visits. A visit ends at the last close before a quiet gap."""
    opened: list[tuple[float, float]] = []  # (open epoch, close epoch or open epoch)
    previous_state: str | None = None
    for moment, state in sorted(points):
        if state in OPEN_STATES and previous_state in CLOSED_STATES:
            opened.append((moment, moment))
        elif state in CLOSED_STATES and opened and previous_state in OPEN_STATES:
            opened[-1] = (opened[-1][0], moment)
        if state in OPEN_STATES | CLOSED_STATES:
            previous_state = state
    visits: list[Visit] = []
    group: list[tuple[float, float]] = []
    for item in opened:
        if group and item[0] - group[-1][1] > VISIT_GAP_S:
            visits.append(_visit(group, zone))
            group = []
        group.append(item)
    if group:
        visits.append(_visit(group, zone))
    return visits


def _visit(group: list[tuple[float, float]], zone: tzinfo) -> Visit:
    return Visit(datetime.fromtimestamp(group[0][0], zone), datetime.fromtimestamp(max(end for _, end in group), zone))


def _clock(minute: int) -> str:
    hour, mins = divmod(minute, 60)
    return f"{hour % 12 or 12}:{mins:02d} {'am' if hour < 12 else 'pm'}"


def find_routines(visits: list[Visit], today: datetime) -> list[dict[str, Any]]:
    """Times of day with a visit on most recent days, earliest first. Today is not counted."""
    earlier = [visit for visit in visits if visit.start.date() < today.date()]
    if not earlier:
        return []
    first_day = min(visit.start.date() for visit in earlier)
    observed = max(1, min(WINDOW_DAYS, (today.date() - first_day).days))
    if observed < MIN_DAYS:
        return []
    ordered = sorted(earlier, key=lambda visit: visit.minute)
    clusters: list[list[Visit]] = []
    for visit in ordered:
        if clusters and visit.minute - clusters[-1][-1].minute <= SLOT_GAP_MIN:
            clusters[-1].append(visit)
        else:
            clusters.append([visit])
    routines = []
    for cluster in clusters:
        days = {visit.start.date() for visit in cluster}
        if len(days) < MIN_DAYS or len(days) / observed < MIN_SHARE:
            continue
        minute = int(statistics.median(visit.minute for visit in cluster))
        lasted = statistics.median(max(1, round((visit.end - visit.start).total_seconds() / 60)) for visit in cluster)
        routines.append({
            "minute": minute, "time": _clock(minute), "daysSeen": len(days), "daysObserved": observed,
            "typicalMinutes": int(lasted),
        })
    return sorted(routines, key=lambda routine: routine["minute"])


def todays_status(routines: list[dict[str, Any]], visits: list[Visit], now: datetime) -> list[dict[str, Any]]:
    """For each routine: done (with the visit), upcoming, expected soon, or late."""
    today_visits = [visit for visit in visits if visit.start.date() == now.date()]
    now_minute = now.hour * 60 + now.minute
    result = []
    for routine in routines:
        minute = routine["minute"]
        match = next((visit for visit in today_visits if minute - MATCH_BEFORE_MIN <= visit.minute <= minute + 180), None)
        if match is not None:
            status = "done"
        elif now_minute > minute + LATE_AFTER_MIN:
            status = "late"
        elif now_minute >= minute - MATCH_BEFORE_MIN:
            status = "expected"
        else:
            status = "upcoming"
        entry = {**routine, "status": status}
        if match is not None:
            entry["at"] = _clock(match.minute)
            entry["minutes"] = max(1, round((match.end - match.start).total_seconds() / 60))
        result.append(entry)
    return result


def clean_label(name: str) -> str:
    """'Patio Door Door' (device name plus entity name) reads as 'Patio Door'."""
    words = name.split()
    cleaned: list[str] = []
    for word in words:
        if not cleaned or cleaned[-1].lower() != word.lower():
            cleaned.append(word)
    return " ".join(cleaned) or name


def routine_report(points: list[tuple[float, str]], zone: tzinfo, now: float) -> dict[str, Any]:
    local = datetime.fromtimestamp(now, zone)
    # Only the recent window counts: a routine that changed a month ago should not linger.
    cutoff = local - timedelta(days=WINDOW_DAYS)
    visits = [visit for visit in visits_from_points(points, zone) if visit.start >= cutoff]
    routines = find_routines(visits, local)
    return {"routines": todays_status(routines, visits, local)}
