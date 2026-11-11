"""Phone notifications: what goes out, when, and only once."""

import asyncio
from datetime import date, datetime
from zoneinfo import ZoneInfo

from app import house_watch, notifier
from tests.test_weather_advice import forecast

ZONE = ZoneInfo("America/New_York")
SETTINGS = {"notifications": {"targets": ["notify.mobile_app_pixel"]}}


def at(month: int, day: int, hour: int, minute: int = 0) -> float:
    return datetime(2026, month, day, hour, minute, tzinfo=ZONE).timestamp()


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, timeout=5))


def make(overrides=None, forecast_data=None, done_for=None, watcher=None):
    sent: list[tuple[str, str, dict]] = []

    async def states():
        return [{"entity_id": "zone.home", "state": "0", "attributes": {"latitude": 40.0, "longitude": -75.0}}]

    async def call_service(domain, service, data):
        sent.append((domain, service, data))

    async def zone():
        return ZONE

    async def get_forecast(latitude, longitude):
        return forecast_data or forecast()

    async def imperial():
        return True

    sources = notifier.Sources(
        get_states=states, call_service=call_service, get_zone=zone,
        get_overrides=lambda: overrides if overrides is not None else SETTINGS,
        get_forecast=get_forecast, get_done_for=lambda: done_for, get_imperial=imperial,
        watcher=watcher, location=lambda found: (40.0, -75.0),
    )
    return notifier.Notifier(sources), sent


def test_nothing_goes_out_without_a_phone():
    notes, sent = make(overrides={})
    assert run(notes.check_once(at(11, 11, 16, 5))) == []
    assert sent == []


def test_bin_night_every_half_hour_once_per_slot_with_one_tag():
    notes, sent = make()
    assert run(notes.check_once(at(11, 11, 15, 55))) == []
    assert run(notes.check_once(at(11, 11, 16, 0))) == ["bins:2026-11-12:0"]
    assert run(notes.check_once(at(11, 11, 16, 10))) == []
    assert run(notes.check_once(at(11, 11, 16, 30))) == ["bins:2026-11-12:1"]
    domain, service, data = sent[0]
    assert (domain, service) == ("notify", "mobile_app_pixel")
    assert data["title"] == "Trash out tonight"
    assert data["data"]["tag"] == "home-panel-bins"


def test_bins_are_out_stops_the_phone_reminders():
    notes, sent = make(done_for=date(2026, 11, 12))
    assert run(notes.check_once(at(11, 11, 17))) == []


def test_forecast_for_tomorrow_waits_for_the_evening_and_respects_quiet_hours():
    windy_tomorrow = forecast(lambda day, hour: {"gust": 70.0} if day == 1 and hour == 14 else None)
    notes, sent = make(forecast_data=windy_tomorrow, overrides={"notifications": {"targets": ["notify.mobile_app_pixel"], "bins": False}})
    # The fixture forecast is anchored to 2026-11-10 at UTC+0, so "now" must be that day.
    assert run(notes.check_once(at(11, 10, 12))) == []
    assert run(notes.check_once(at(11, 10, 17, 30))) == ["forecast:2026-11-10:wind:tomorrow"]
    assert run(notes.check_once(at(11, 10, 18))) == []


def test_critical_house_watch_finding_goes_out_even_in_quiet_hours():
    watcher = house_watch.HouseWatch(get_states=None, call_service=None)
    watcher._open[("garage_open", "cover.garage")] = {
        "rule": "garage_open", "category": "garage", "severity": "critical", "entityId": "cover.garage",
        "name": "Garage door", "detail": "Open after dark (20m)", "startedAt": at(11, 10, 23, 0),
    }
    notes, sent = make(watcher=watcher, overrides={"notifications": {"targets": ["notify.mobile_app_pixel"], "forecast": False}})
    assert run(notes.check_once(at(11, 10, 23, 30))) == ["watch:garage_open:cover.garage:" + f"{at(11, 10, 23, 0):.0f}"]
    assert sent[0][2]["title"] == "Garage door"


def test_quiet_hours_wrap_past_midnight():
    settings = notifier.NotifySettings()
    from datetime import time
    assert notifier.in_quiet_hours(time(23, 0), settings)
    assert notifier.in_quiet_hours(time(6, 59), settings)
    assert not notifier.in_quiet_hours(time(7, 0), settings)
    assert not notifier.in_quiet_hours(time(21, 59), settings)
