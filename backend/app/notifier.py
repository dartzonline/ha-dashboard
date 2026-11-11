"""Phone notifications through Home Assistant's notify services.

Four kinds, each switched on or off in Settings > Reminders, and each sent once:

* Bin night: every reminder slot on the evening before pickup, until someone taps "Bins are out".
  All share one notification tag, so a phone shows the latest rather than a stack of them.
* Forecast warnings (warning or worse) for today and tonight, and for tomorrow from 5 pm.
* Critical house-watch findings: the garage open after dark, a freezer warming up.
* The weekly house report, Sunday at 7 pm.

Quiet hours hold back everything except critical house-watch findings: a garage left open at
midnight is exactly when someone should hear about it.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, time as clock_time, tzinfo
from typing import Any, Awaitable, Callable

from . import bins, house_watch, weather_advice, weekly

logger = logging.getLogger(__name__)

CHECK_INTERVAL_S = 60.0
FORGET_AFTER_S = 3 * 86400.0
TOMORROW_FROM_HOUR = 17
WEEKLY_WEEKDAY = 6  # Sunday
WEEKLY_HOUR = 19
RUN_NOTICE_AFTER_S = 5 * 60.0
SALT_NOTICE_DAYS = 10.0
_CLOCK = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


@dataclass(frozen=True)
class NotifySettings:
    targets: tuple[str, ...] = ()
    forecast: bool = True
    house_watch: bool = True
    bins: bool = True
    weekly: bool = True
    quiet_start: clock_time = clock_time(22, 0)
    quiet_end: clock_time = clock_time(7, 0)


def _clock(value: Any, default: clock_time) -> clock_time:
    match = _CLOCK.match(value) if isinstance(value, str) else None
    return clock_time(int(match.group(1)), int(match.group(2))) if match else default


def settings_from_overrides(overrides: dict[str, Any]) -> NotifySettings:
    raw = overrides.get("notifications")
    if not isinstance(raw, dict):
        return NotifySettings()
    default = NotifySettings()
    targets = raw.get("targets")
    flag = lambda key, fallback: raw.get(key) if isinstance(raw.get(key), bool) else fallback  # noqa: E731
    return NotifySettings(
        targets=tuple(item for item in targets if isinstance(item, str) and item.startswith("notify.")) if isinstance(targets, list) else (),
        forecast=flag("forecast", default.forecast),
        house_watch=flag("houseWatch", default.house_watch),
        bins=flag("bins", default.bins),
        weekly=flag("weekly", default.weekly),
        quiet_start=_clock(raw.get("quietStart"), default.quiet_start),
        quiet_end=_clock(raw.get("quietEnd"), default.quiet_end),
    )


def settings_as_dict(settings: NotifySettings) -> dict[str, Any]:
    return {
        "targets": list(settings.targets),
        "forecast": settings.forecast,
        "houseWatch": settings.house_watch,
        "bins": settings.bins,
        "weekly": settings.weekly,
        "quietStart": settings.quiet_start.strftime("%H:%M"),
        "quietEnd": settings.quiet_end.strftime("%H:%M"),
    }


def in_quiet_hours(now: clock_time, settings: NotifySettings) -> bool:
    start, end = settings.quiet_start, settings.quiet_end
    if start == end:
        return False
    return start <= now < end if start < end else now >= start or now < end


@dataclass(frozen=True)
class Message:
    key: str
    title: str
    message: str
    tag: str
    critical: bool = False


@dataclass
class Sources:
    """Everything the notifier reads, injectable so it can be tested without Home Assistant."""

    get_states: Callable[[], Awaitable[list[dict[str, Any]]]]
    call_service: Callable[[str, str, dict[str, Any]], Awaitable[Any]]
    get_zone: Callable[[], Awaitable[tzinfo]]
    get_overrides: Callable[[], dict[str, Any]]
    get_forecast: Callable[[float, float], Awaitable[dict[str, Any]]] | None = None
    get_done_for: Callable[[], Any] = bins.load_done_for
    get_imperial: Callable[[], Awaitable[bool]] | None = None
    watcher: house_watch.HouseWatch | None = None
    location: Callable[[list[dict[str, Any]]], tuple[float, float] | None] = field(default=lambda states: None)
    get_run_status: Callable[[], Awaitable[dict[str, Any]]] | None = None
    get_salt_forecast: Callable[[], dict[str, Any]] | None = None


class Notifier:
    def __init__(self, sources: Sources, interval: float = CHECK_INTERVAL_S) -> None:
        self.sources = sources
        self._interval = interval
        self.sent: dict[str, float] = {}

    async def due(self, now: float | None = None) -> list[Message]:
        """Every message that should go out now and has not been sent yet."""
        moment = now if now is not None else time.time()
        overrides = self.sources.get_overrides()
        settings = settings_from_overrides(overrides)
        if not settings.targets:
            return []
        zone = await self.sources.get_zone()
        local = datetime.fromtimestamp(moment, zone)
        quiet = in_quiet_hours(local.time(), settings)
        messages: list[Message] = []

        if settings.bins:
            bin_status = bins.status(local, bins.schedule_from_overrides(overrides), self.sources.get_done_for())
            if bin_status["phase"] == "evening":
                messages.append(Message(
                    f"bins:{bin_status['pickupDate']}:{bin_status['slot']}", bin_status["title"], bin_status["message"],
                    tag="home-panel-bins",
                ))

        if settings.house_watch and self.sources.watcher is not None:
            for entry in self.sources.watcher.report_journal():
                if entry["endedAt"] is None and entry["severity"] == "critical":
                    messages.append(Message(
                        f"watch:{entry['rule']}:{entry['entityId']}:{entry['startedAt']:.0f}",
                        entry["name"], entry["detail"], tag=f"home-panel-watch-{entry['entityId']}", critical=True,
                    ))

        states: list[dict[str, Any]] | None = None
        if settings.forecast and not quiet and self.sources.get_forecast is not None:
            states = await self.sources.get_states()
            location = self.sources.location(states)
            if location is not None:
                try:
                    forecast = await self.sources.get_forecast(*location)
                    imperial = await self.sources.get_imperial() if self.sources.get_imperial else True
                    for item in weather_advice.build_advice(forecast, imperial, moment):
                        if item.severity == "info" or item.window not in ("today", "tonight", "tomorrow"):
                            continue
                        if item.window == "tomorrow" and local.hour < TOMORROW_FROM_HOUR:
                            continue
                        messages.append(Message(
                            f"forecast:{local.date().isoformat()}:{item.id}", item.title, item.detail, tag=f"home-panel-{item.id}",
                        ))
                except Exception as error:  # noqa: BLE001 - no forecast this minute; the rest still goes out
                    logger.debug("Notifier skipped the forecast: %s", error)

        if settings.house_watch and self.sources.get_run_status is not None:
            run = await self.sources.get_run_status()
            left = [item["label"] for item in run.get("leftBehind", [])]
            departed = run.get("departedAt")
            if run.get("phase") == "out" and left and departed:
                started = datetime.fromisoformat(departed).timestamp()
                if moment - started >= RUN_NOTICE_AFTER_S:
                    messages.append(Message(
                        f"run:{departed}", f"You left {len(left)} thing{'s' if len(left) != 1 else ''}",
                        " · ".join(left[:5]) + ". Open the dashboard to secure the house.", tag="home-panel-run",
                    ))

        if settings.house_watch and not quiet and self.sources.get_salt_forecast is not None:
            salt = self.sources.get_salt_forecast()
            if salt.get("daysToLow") is not None and salt["daysToLow"] <= SALT_NOTICE_DAYS:
                messages.append(Message(
                    f"salt:{salt.get('lowOn')}", "Buy water softener salt",
                    f"The softener reaches 20% in about {salt['daysToLow']:.0f} days.", tag="home-panel-salt",
                ))

        if settings.weekly and not quiet and local.weekday() == WEEKLY_WEEKDAY and local.hour >= WEEKLY_HOUR and self.sources.watcher is not None:
            report = weekly.weekly_report(self.sources.watcher.report_journal(), self.sources.watcher.actions, moment)
            messages.append(Message(f"weekly:{local.date().isoformat()}", "Your week at home", weekly.summary_text(report), tag="home-panel-weekly"))

        return [message for message in messages if message.key not in self.sent and (message.critical or not quiet or message.key.startswith("bins:"))]

    async def send(self, message: Message, targets: tuple[str, ...]) -> bool:
        delivered = False
        for target in targets:
            domain, _, service = target.partition(".")
            try:
                await self.sources.call_service(domain, service, {
                    "title": message.title,
                    "message": message.message,
                    "data": {"tag": message.tag, "group": "home-panel"},
                })
                delivered = True
            except Exception as error:  # noqa: BLE001 - one phone off the network must not stop the others
                logger.warning("Could not notify %s: %s", target, error)
        return delivered

    async def check_once(self, now: float | None = None) -> list[str]:
        moment = now if now is not None else time.time()
        settings = settings_from_overrides(self.sources.get_overrides())
        sent: list[str] = []
        for message in await self.due(moment):
            if await self.send(message, settings.targets):
                self.sent[message.key] = moment
                sent.append(message.key)
        self.sent = {key: at for key, at in self.sent.items() if moment - at < FORGET_AFTER_S}
        return sent

    async def run(self) -> None:
        while True:
            try:
                await self.check_once()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - Home Assistant down; try next tick
                logger.debug("Notifier check skipped: %s", error)
            await asyncio.sleep(self._interval)
