"""Bin night, against the household's real schedule: trash every Thursday, recycling on
alternate Thursdays, and the week of 2026-11-12 is trash only."""

from datetime import date, datetime
from zoneinfo import ZoneInfo

from app import bins

ZONE = ZoneInfo("America/New_York")
SCHEDULE = bins.BinSchedule()


def at(month: int, day: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, month, day, hour, minute, tzinfo=ZONE)


def test_this_thursday_is_trash_only_and_next_adds_recycling():
    assert bins.collection_on_or_after(date(2026, 11, 10), SCHEDULE) == (date(2026, 11, 12), ["trash"])
    assert bins.collection_on_or_after(date(2026, 11, 13), SCHEDULE) == (date(2026, 11, 19), ["trash", "recycling"])
    assert bins.collection_on_or_after(date(2026, 11, 20), SCHEDULE) == (date(2026, 11, 26), ["trash"])
    assert bins.collection_on_or_after(date(2026, 12, 1), SCHEDULE) == (date(2026, 12, 3), ["trash", "recycling"])


def test_wednesday_reminders_every_half_hour_from_four_until_ten():
    assert bins.status(at(11, 11, 15, 59), SCHEDULE, None)["phase"] is None
    first = bins.status(at(11, 11, 16, 0), SCHEDULE, None)
    assert (first["phase"], first["slot"], first["title"]) == ("evening", 0, "Trash out tonight")
    assert bins.status(at(11, 11, 16, 29), SCHEDULE, None)["slot"] == 0
    assert bins.status(at(11, 11, 16, 30), SCHEDULE, None)["slot"] == 1
    assert bins.status(at(11, 11, 21, 59), SCHEDULE, None)["slot"] == 11
    assert bins.status(at(11, 11, 22, 0), SCHEDULE, None)["phase"] is None


def test_recycling_week_says_so():
    evening = bins.status(at(11, 18, 17), SCHEDULE, None)
    assert evening["title"] == "Trash and recycling out tonight"
    assert "trash and recycling bins" in evening["message"]


def test_pickup_morning_asks_until_ten_then_moves_on():
    morning = bins.status(at(11, 12, 7, 30), SCHEDULE, None)
    assert (morning["phase"], morning["pickupLabel"]) == ("morning", "Today")
    later = bins.status(at(11, 12, 10, 0), SCHEDULE, None)
    assert later["phase"] is None
    assert later["pickupDate"] == "2026-11-19"
    assert later["pickupLabel"] == "Thursday"


def test_bins_are_out_silences_that_pickup_only():
    done = bins.status(at(11, 11, 18), SCHEDULE, date(2026, 11, 12))
    assert done["done"] is True and done["phase"] is None
    assert bins.status(at(11, 12, 8), SCHEDULE, date(2026, 11, 12))["phase"] is None
    assert bins.status(at(11, 18, 18), SCHEDULE, date(2026, 11, 12))["phase"] == "evening"


def test_disabled_schedule_never_reminds():
    off = bins.BinSchedule(enabled=False)
    assert bins.status(at(11, 11, 18), off, None)["phase"] is None


def test_overrides_round_trip_and_bad_values_fall_back():
    schedule = bins.schedule_from_overrides({"binSchedule": {
        "trashWeekday": 1, "recycling": "weekly", "remindStart": "18:30", "remindEnd": "21:00", "intervalMinutes": 60,
    }})
    assert bins.schedule_as_dict(schedule)["remindStart"] == "18:30"
    assert bins.collection_on_or_after(date(2026, 11, 10), schedule) == (date(2026, 11, 10), ["trash", "recycling"])
    fallback = bins.schedule_from_overrides({"binSchedule": {"trashWeekday": 9, "remindStart": "25:00", "recycling": "daily"}})
    assert fallback == bins.BinSchedule()


def test_done_state_is_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(bins, "_state_path", lambda: tmp_path / "bins-state.json")
    assert bins.load_done_for() is None
    bins.save_done_for(date(2026, 11, 12))
    assert bins.load_done_for() == date(2026, 11, 12)
    bins.save_done_for(None)
    assert bins.load_done_for() is None
