"""House watch: things left running or left open, and how long for.

Home Assistant shows that a light is on or a door is open, but not how long it
has been that way. Most of what goes wrong in a house shows up as time: a light
burning all day in an empty room, the garage left open overnight, a sprinkler
zone stuck on. Each rule here reads `last_changed` and decides when the state
turns into a finding.

Every rule warns. Only rules where switching something *off* is always safe
take action, and only after a much longer delay than the warning:

| Rule            | Warns  | Escalates | Action                    |
| --------------- | ------ | --------- | ------------------------- |
| Light left on   | 2h     | --        | switched off at 4h        |
| Irrigation      | 1h     | --        | shut off at 2h            |
| Fridge door     | --     | 5m        | --                        |
| Garage open     | 30m    | 2h        | --                        |
| Lock unlocked   | 30m    | --        | --                        |
| Open while HVAC | 10m    | --        | --                        |
| Away, light on  | 30m    | --        | --                        |
| Away, media on  | 30m    | --        | --                        |

Garages and locks are never acted on. Closing a garage door that nobody can
see, or throwing a deadbolt on a door that may be ajar, is the kind of thing
a person should decide.

Lights meant to stay on are exempt. Landscape lighting runs all night, so any
light whose entity id or name contains one of `EXEMPT_LIGHT_TERMS` is ignored
by every rule. Light *groups* (Home Assistant light groups and Hue rooms) are
skipped too. Their members are judged one by one, and switching off a group
could switch off an exempt light inside it.

Errors all go in the safe direction. A Home Assistant restart rewrites
`last_changed` on every entity, which can only make a state look *younger*,
so the worst case is a late warning or a late switch-off, never an early one.
A missing timestamp means the entity is left alone.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable

logger = logging.getLogger(__name__)

MINUTE = 60.0
HOUR = 3600.0

LIGHT_WARN_AFTER_S = 2 * HOUR
LIGHT_AUTO_OFF_AFTER_S = 4 * HOUR
IRRIGATION_WARN_AFTER_S = 1 * HOUR
IRRIGATION_AUTO_OFF_AFTER_S = 2 * HOUR
FRIDGE_CRITICAL_AFTER_S = 5 * MINUTE
GARAGE_WARN_AFTER_S = 30 * MINUTE
GARAGE_CRITICAL_AFTER_S = 2 * HOUR
LOCK_WARN_AFTER_S = 30 * MINUTE
HVAC_OPEN_WARN_AFTER_S = 10 * MINUTE
AWAY_WARN_AFTER_S = 30 * MINUTE

# Matched case-insensitively against the entity id *and* the friendly name.
EXEMPT_LIGHT_TERMS: tuple[str, ...] = ("landscape",)
IRRIGATION_TERMS: tuple[str, ...] = ("irrigation", "sprinkler", "drip")
FRIDGE_TERMS: tuple[str, ...] = ("fridge", "freezer", "refrigerator")
GARAGE_TERMS: tuple[str, ...] = ("garage", "garrage")

OPENING_CLASSES = {"door", "window", "opening"}
DEAD_STATES = {"unavailable", "unknown"}

# How often the backend checks. A minute is precise enough for the shortest
# limit here and costs one /api/states call per minute.
CHECK_INTERVAL_S = 60.0

# After a failed action, wait this long before trying the same entity again, so
# an unreachable bulb does not get a service call every minute all night.
RETRY_AFTER_S = 15 * MINUTE

SEVERITY_RANK = {"critical": 0, "warning": 1, "info": 2}


# --- entity helpers -------------------------------------------------------


def _parse_time(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _name(entity: dict[str, Any]) -> str:
    attributes = entity.get("attributes") or {}
    return str(attributes.get("friendly_name") or entity.get("entity_id") or "")


def _domain(entity: dict[str, Any]) -> str:
    return str(entity.get("entity_id", "")).split(".", 1)[0]


def _device_class(entity: dict[str, Any]) -> str:
    return str((entity.get("attributes") or {}).get("device_class") or "")


def _mentions(entity: dict[str, Any], terms: Iterable[str]) -> bool:
    searchable = f"{entity.get('entity_id', '')} {_name(entity)}".lower()
    return any(term in searchable for term in terms)


def is_exempt_light(entity: dict[str, Any]) -> bool:
    """True for lights meant to stay on, such as landscape lighting."""
    return _mentions(entity, EXEMPT_LIGHT_TERMS)


def is_group(entity: dict[str, Any]) -> bool:
    """A light that stands for other lights: a light group or a Hue room/zone."""
    attributes = entity.get("attributes") or {}
    return isinstance(attributes.get("entity_id"), list) or bool(attributes.get("is_hue_group"))


def _watched_light(entity: dict[str, Any]) -> bool:
    return (
        _domain(entity) == "light"
        and entity.get("state") == "on"
        and not is_exempt_light(entity)
        and not is_group(entity)
    )


def duration_label(seconds: float) -> str:
    """'2h 05m', or '45m' under an hour."""
    hours, minutes = divmod(int(seconds) // 60, 60)
    return f"{hours}h {minutes:02d}m" if hours else f"{minutes}m"


# --- house-wide context ---------------------------------------------------


@dataclass(frozen=True)
class Context:
    now: float
    # When the last person left, if everyone tracked is away; else None.
    away_since: float | None
    # "heating" or "cooling" if any thermostat is actively running, else None.
    hvac_action: str | None


def build_context(states: list[dict[str, Any]], now: float) -> Context:
    people = [entity for entity in states if _domain(entity) == "person"]
    away_since: float | None = None
    # Everyone must be known *and* away. A person in `unknown` might be home,
    # and "nobody is tracked" is not the same as "nobody is home".
    if people and all(entity.get("state") not in DEAD_STATES | {"home"} for entity in people):
        stamps = [_parse_time(entity.get("last_changed")) for entity in people]
        if all(stamp is not None for stamp in stamps):
            away_since = max(stamp for stamp in stamps if stamp is not None)

    hvac_action: str | None = None
    for entity in states:
        if _domain(entity) != "climate":
            continue
        action = str((entity.get("attributes") or {}).get("hvac_action") or "")
        if action in ("heating", "cooling"):
            hvac_action = action
            break
    return Context(now=now, away_since=away_since, hvac_action=hvac_action)


# --- rules ----------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    rule: str
    category: str
    severity: str
    entity_id: str
    name: str
    seconds: float
    detail: str
    # Set when the rule will act, with the moment it does.
    action: tuple[str, str] | None = None
    action_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "rule": self.rule,
            "category": self.category,
            "severity": self.severity,
            "entityId": self.entity_id,
            "name": self.name,
            "seconds": round(self.seconds),
            "detail": self.detail,
            "actionAt": _iso(self.action_at) if self.action_at is not None else None,
        }


Rule = Callable[[dict[str, Any], float, Context], "Finding | None"]


def _light_left_on(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if not _watched_light(entity):
        return None
    on_for = ctx.now - since
    if on_for < LIGHT_WARN_AFTER_S:
        return None
    overdue = on_for >= LIGHT_AUTO_OFF_AFTER_S
    return Finding(
        rule="light_left_on", category="light", severity="warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=on_for,
        detail=f"On for {duration_label(on_for)} — " + ("switching off now" if overdue else "switches off at 4h"),
        action=("light", "turn_off"), action_at=since + LIGHT_AUTO_OFF_AFTER_S,
    )


def _irrigation_running(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    domain = _domain(entity)
    running = (domain == "valve" and entity.get("state") == "open") or (domain == "switch" and entity.get("state") == "on")
    if not running or not _mentions(entity, IRRIGATION_TERMS):
        return None
    on_for = ctx.now - since
    if on_for < IRRIGATION_WARN_AFTER_S:
        return None
    overdue = on_for >= IRRIGATION_AUTO_OFF_AFTER_S
    action = ("valve", "close_valve") if domain == "valve" else ("switch", "turn_off")
    return Finding(
        rule="irrigation_running", category="water", severity="warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=on_for,
        detail=f"Running for {duration_label(on_for)} — " + ("shutting off now" if overdue else "shuts off at 2h"),
        action=action, action_at=since + IRRIGATION_AUTO_OFF_AFTER_S,
    )


def _fridge_door_open(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if _domain(entity) != "binary_sensor" or entity.get("state") != "on":
        return None
    if _device_class(entity) not in OPENING_CLASSES or not _mentions(entity, FRIDGE_TERMS):
        return None
    open_for = ctx.now - since
    if open_for < FRIDGE_CRITICAL_AFTER_S:
        return None
    return Finding(
        rule="fridge_door_open", category="fridge", severity="critical",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=open_for,
        detail=f"Door open for {duration_label(open_for)}",
    )


def _is_garage(entity: dict[str, Any]) -> bool:
    domain = _domain(entity)
    if domain == "cover":
        return entity.get("state") in ("open", "opening") and (
            _device_class(entity) == "garage" or _mentions(entity, GARAGE_TERMS)
        )
    if domain == "binary_sensor":
        return entity.get("state") == "on" and _device_class(entity) == "garage_door"
    return False


def _garage_open(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if not _is_garage(entity):
        return None
    open_for = ctx.now - since
    if open_for < GARAGE_WARN_AFTER_S:
        return None
    return Finding(
        rule="garage_open", category="garage",
        severity="critical" if open_for >= GARAGE_CRITICAL_AFTER_S else "warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=open_for,
        detail=f"Open for {duration_label(open_for)}",
    )


def _lock_unlocked(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if _domain(entity) != "lock" or entity.get("state") != "unlocked":
        return None
    unlocked_for = ctx.now - since
    if unlocked_for < LOCK_WARN_AFTER_S:
        return None
    return Finding(
        rule="lock_unlocked", category="lock", severity="warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=unlocked_for,
        detail=f"Unlocked for {duration_label(unlocked_for)}",
    )


def _open_while_hvac(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if ctx.hvac_action is None:
        return None
    if _domain(entity) != "binary_sensor" or entity.get("state") != "on":
        return None
    if _device_class(entity) not in OPENING_CLASSES or _mentions(entity, FRIDGE_TERMS + GARAGE_TERMS):
        return None
    open_for = ctx.now - since
    if open_for < HVAC_OPEN_WARN_AFTER_S:
        return None
    return Finding(
        rule="open_while_hvac", category="energy", severity="warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=open_for,
        detail=f"Open for {duration_label(open_for)} while the HVAC is {ctx.hvac_action}",
    )


def _away_and_on(entity: dict[str, Any], since: float, ctx: Context) -> Finding | None:
    if ctx.away_since is None:
        return None
    domain = _domain(entity)
    if domain == "light":
        if not _watched_light(entity):
            return None
        verb = "On"
    elif domain == "media_player":
        if entity.get("state") not in ("playing", "on"):
            return None
        verb = "Playing" if entity.get("state") == "playing" else "On"
    else:
        return None
    # Counts from whichever happened later: the device coming on, or the last
    # person leaving.
    wasted = ctx.now - max(since, ctx.away_since)
    if wasted < AWAY_WARN_AFTER_S:
        return None
    return Finding(
        rule="away_and_on", category="away", severity="warning",
        entity_id=str(entity["entity_id"]), name=_name(entity), seconds=wasted,
        detail=f"{verb} while everyone is away ({duration_label(wasted)})",
    )


RULES: tuple[Rule, ...] = (
    _light_left_on,
    _irrigation_running,
    _fridge_door_open,
    _garage_open,
    _lock_unlocked,
    _open_while_hvac,
    _away_and_on,
)


def _better(candidate: Finding, current: Finding) -> bool:
    """One finding per entity: the most severe, then the one that will act."""
    left, right = SEVERITY_RANK[candidate.severity], SEVERITY_RANK[current.severity]
    if left != right:
        return left < right
    return candidate.action is not None and current.action is None


def findings(states: Iterable[dict[str, Any]], now: float | None = None) -> list[Finding]:
    """Every current finding, most severe first, then longest-running."""
    moment = now if now is not None else time.time()
    states = list(states)
    ctx = build_context(states, moment)
    by_entity: dict[str, Finding] = {}
    for entity in states:
        since = _parse_time(entity.get("last_changed"))
        if since is None or entity.get("state") in DEAD_STATES:
            continue
        for rule in RULES:
            found = rule(entity, since, ctx)
            if found is None:
                continue
            current = by_entity.get(found.entity_id)
            if current is None or _better(found, current):
                by_entity[found.entity_id] = found
    ordered = sorted(by_entity.values(), key=lambda item: (SEVERITY_RANK[item.severity], -item.seconds))
    return ordered


def due_actions(states: Iterable[dict[str, Any]], now: float | None = None) -> list[tuple[str, str, str]]:
    """(domain, service, entity_id) for every finding whose action time has passed."""
    moment = now if now is not None else time.time()
    return [
        (item.action[0], item.action[1], item.entity_id)
        for item in findings(states, moment)
        if item.action is not None and item.action_at is not None and item.action_at <= moment
    ]


def attention_items(states: Iterable[dict[str, Any]], now: float | None = None) -> list[dict[str, Any]]:
    """Health-list entries in the same shape as `home_health.attention_items`."""
    return [
        {
            "severity": item.severity,
            "category": item.category,
            "title": item.name,
            "detail": item.detail,
            "entityId": item.entity_id,
        }
        for item in findings(states, now)
    ]


THRESHOLDS = {
    "lightWarnAfterSeconds": LIGHT_WARN_AFTER_S,
    "lightAutoOffAfterSeconds": LIGHT_AUTO_OFF_AFTER_S,
    "irrigationWarnAfterSeconds": IRRIGATION_WARN_AFTER_S,
    "irrigationAutoOffAfterSeconds": IRRIGATION_AUTO_OFF_AFTER_S,
    "fridgeCriticalAfterSeconds": FRIDGE_CRITICAL_AFTER_S,
    "garageWarnAfterSeconds": GARAGE_WARN_AFTER_S,
    "garageCriticalAfterSeconds": GARAGE_CRITICAL_AFTER_S,
    "lockWarnAfterSeconds": LOCK_WARN_AFTER_S,
    "hvacOpenWarnAfterSeconds": HVAC_OPEN_WARN_AFTER_S,
    "awayWarnAfterSeconds": AWAY_WARN_AFTER_S,
}


# --- background loop ------------------------------------------------------

StatesFn = Callable[[], Awaitable[list[dict[str, Any]]]]
ServiceFn = Callable[[str, str, dict[str, Any]], Awaitable[Any]]


class HouseWatch:
    """Background loop that carries out due actions (switching things off)."""

    def __init__(self, get_states: StatesFn, call_service: ServiceFn, interval: float = CHECK_INTERVAL_S) -> None:
        self._get_states = get_states
        self._call_service = call_service
        self._interval = interval
        self._failed_at: dict[str, float] = {}
        # Most recent automatic actions, newest first, for the status endpoint.
        self.recent: list[dict[str, Any]] = []

    async def check_once(self, now: float | None = None) -> list[str]:
        """One pass: carry out every due action. Returns the entity ids acted on."""
        moment = now if now is not None else time.time()
        states = await self._get_states()
        acted: list[str] = []
        for domain, service, entity_id in due_actions(states, moment):
            failed = self._failed_at.get(entity_id)
            if failed is not None and moment - failed < RETRY_AFTER_S:
                continue
            try:
                await self._call_service(domain, service, {"entity_id": entity_id})
            except Exception as error:  # noqa: BLE001 - one bad device must not stop the rest
                self._failed_at[entity_id] = moment
                logger.warning("House watch could not run %s.%s on %s: %s", domain, service, entity_id, error)
                continue
            self._failed_at.pop(entity_id, None)
            acted.append(entity_id)
            self.recent.insert(0, {"entityId": entity_id, "service": f"{domain}.{service}", "at": _iso(moment)})
            logger.info("House watch ran %s.%s on %s", domain, service, entity_id)
        del self.recent[20:]
        return acted

    async def run(self) -> None:
        while True:
            try:
                await self.check_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - Home Assistant down; try next tick
                logger.debug("House watch check skipped: %s", error)
            await asyncio.sleep(self._interval)
