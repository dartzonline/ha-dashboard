"""Departure charge and climate, fridge energy trend, and HVAC runtime with the filter."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from app import departure, fridge_trend, hvac_runtime

ZONE = ZoneInfo("America/Chicago")


def epoch(month: int, day: int, hour: int, minute: int = 0) -> float:
    return datetime(2026, month, day, hour, minute, tzinfo=ZONE).timestamp()


# --- departure -----------------------------------------------------------------


def garage_mornings(days: list[int], hour: int = 8, minute: int = 30) -> list[tuple[float, str]]:
    points: list[tuple[float, str]] = []
    for day in days:
        points += [(epoch(11, day, 7, 0), "closed"), (epoch(11, day, hour, minute), "opening"), (epoch(11, day, hour, minute, ) + 15, "open"),
                   (epoch(11, day, 9, 30), "opening"), (epoch(11, day, 17, 0), "opening")]
    return points


class TestDeparture:
    def test_first_morning_opening_only_and_weekday_median(self):
        # Nov 2-6 and 9-11 2026 are weekdays; one late morning does not move the median.
        found = departure.morning_departures(garage_mornings([2, 3, 4, 5, 6, 9, 10]) + garage_mornings([11], 10, 5), ZONE, ("opening", "open"))
        assert found["2026-11-02"] == 8 * 60 + 30
        typical = departure.typical_departures(found)
        assert typical["weekday"] == {"minute": 510, "days": 8}
        assert typical["weekend"] is None

    def test_next_departure_today_then_tomorrow_skipping_weekends(self):
        typical = {"weekday": {"minute": 510, "days": 8}, "weekend": None}
        thursday_morning = datetime(2026, 11, 12, 7, 0, tzinfo=ZONE)
        assert departure.next_departure(typical, thursday_morning).day == 12
        # Still "leaving now" just after, then the next weekday.
        assert departure.next_departure(typical, thursday_morning.replace(hour=8, minute=45)).day == 12
        friday_noon = datetime(2026, 11, 13, 12, 0, tzinfo=ZONE)
        assert departure.next_departure(typical, friday_noon).day == 16

    def test_charge_by_departure(self):
        # The car's own time-to-full: 60% to go in 8 h, 4 h away -> half of it.
        assert departure.charge_at(40, 100, True, True, 4, 480, None) == 70
        # Learned speed when the car gives no estimate, never past the target.
        assert departure.charge_at(40, 80, True, False, 10, None, 8.0) == 80
        assert departure.charge_at(40, 100, False, False, 10, 480, 8.0) == 40

    def test_plan_warns_to_plug_in_and_offers_warm_up_on_a_cold_morning(self):
        found = {f"2026-11-{day:02d}": 510 for day in (2, 3, 4, 5, 6, 9)}
        forecast = {"hourly": {"time": ["2026-11-13T08:00", "2026-11-13T09:00"], "apparent_temperature": [1.5, 6.0]}}
        plan = departure.departure_plan(
            found=found, now=datetime(2026, 11, 12, 21, 0, tzinfo=ZONE), level=22, target=100, plugged=False, charging=False,
            minutes_to_full=None, pct_per_hour=8, miles_per_pct=0.36, forecast=forecast,
        )
        leave = plan["departure"]
        assert leave["time"] == "8:30 am" and leave["day"] == "tomorrow"
        assert leave["needsPlug"] is True and leave["levelAtDeparture"] == 22 and leave["rangeAtDeparture"] == 8
        assert leave["climate"] == "warm" and leave["feelsLikeC"] == 1.5

    def test_hot_and_mild_mornings(self):
        assert departure.climate_suggestion(31) == "cool"
        assert departure.climate_suggestion(15) is None
        assert departure.climate_suggestion(None) is None

    def test_too_few_mornings_means_no_departure(self):
        plan = departure.departure_plan(
            found={"2026-11-02": 510}, now=datetime(2026, 11, 12, 21, 0, tzinfo=ZONE), level=50, target=100, plugged=True,
            charging=True, minutes_to_full=300, pct_per_hour=None, miles_per_pct=None, forecast=None,
        )
        assert plan["departure"] is None


# --- fridge ----------------------------------------------------------------------


def stats_rows(values: dict[date, float]) -> list[dict]:
    return [{"start": datetime(day.year, day.month, day.day, tzinfo=ZONE).timestamp() * 1000, "change": value} for day, value in values.items()]


class TestFridge:
    def test_drops_month_boundaries_and_scales_wh(self):
        rows = stats_rows({date(2026, 10, 30): 2000, date(2026, 10, 31): 400, date(2026, 11, 1): 0, date(2026, 11, 2): 2100})
        days = fridge_trend.daily_use(rows, ZONE, 0.001)
        assert days == {date(2026, 10, 30): 2.0, date(2026, 11, 2): 2.1}

    def series(self, recent: float) -> dict[date, float]:
        today = date(2026, 11, 13)
        return {today - timedelta(days=back): (recent if back <= 14 else 2.0) for back in range(1, 100)}

    def test_steady_use_is_ok_and_priced(self):
        report = fridge_trend.fridge_trend(self.series(2.05), date(2026, 11, 13), 0.11)
        assert report["status"] == "ok" and report["yearlyCost"] == round(2.05 * 365 * 0.11)
        assert report["weeks"] and report["advice"] == []

    def test_a_rise_gets_coil_and_seal_advice(self):
        report = fridge_trend.fridge_trend(self.series(2.6), date(2026, 11, 13), 0.11)
        assert report["status"] == "high" and report["rise"] == 0.3
        assert "coils" in report["advice"][0] and "seal" in report["advice"][1]

    def test_too_little_history_is_learning(self):
        today = date(2026, 11, 13)
        report = fridge_trend.fridge_trend({today - timedelta(days=back): 2.0 for back in range(1, 20)}, today, 0.11)
        assert report["status"] == "learning"

    def test_freezer_colder_than_needed(self):
        states = [
            {"entity_id": "number.refrigerator_freezer_temperature", "state": "-4", "attributes": {"unit_of_measurement": "°F"}},
            {"entity_id": "number.refrigerator_fridge_temperature", "state": "38", "attributes": {"unit_of_measurement": "°F"}},
        ]
        assert fridge_trend.settings_advice(states) == ["The freezer is set to -4°F. 0 °F (-18 °C) keeps food safe and uses less."]


# --- HVAC --------------------------------------------------------------------------


class TestHvac:
    def test_runtime_splits_at_midnight_and_counts_cycles(self):
        points = [(epoch(11, 10, 23, 0), "idle"), (epoch(11, 10, 23, 30), "cooling"), (epoch(11, 11, 0, 30), "idle"),
                  (epoch(11, 11, 6, 0), "cooling"), (epoch(11, 11, 6, 15), "cooling"), (epoch(11, 11, 6, 30), "idle")]
        days = hvac_runtime.daily_runtime(points, ZONE, epoch(11, 11, 12))
        assert days["2026-11-10"] == {"coolH": 0.5, "heatH": 0.0, "cycles": 1}
        assert days["2026-11-11"]["coolH"] == 1.0 and days["2026-11-11"]["cycles"] == 1

    def log(self, tmp_path, recent_hours: float) -> hvac_runtime.HvacLog:
        log = hvac_runtime.HvacLog(tmp_path / "hvac.json")
        today = date(2026, 11, 13)
        runtime, outdoor = {}, {}
        for back in range(1, 60):
            day = (today - timedelta(days=back)).isoformat()
            temp = 80 + (back % 3)
            runtime[day] = {"coolH": recent_hours if back <= 7 else 4.0, "heatH": 0.0, "cycles": 12}
            outdoor[day] = temp
        log.merge(runtime, outdoor, today)
        return log

    def test_longer_runs_in_the_same_weather_point_at_the_filter(self, tmp_path):
        report = hvac_runtime.hvac_report(self.log(tmp_path, 5.6), None, date(2026, 11, 13))
        assert report["efficiency"]["status"] == "longer" and report["efficiency"]["ratio"] == 1.4
        assert "filter" in report["advice"][0]

    def test_same_runtime_is_ok_and_new_logs_are_learning(self, tmp_path):
        assert hvac_runtime.hvac_report(self.log(tmp_path, 4.1), None, date(2026, 11, 13))["efficiency"]["status"] == "ok"
        fresh = hvac_runtime.HvacLog(None)
        fresh.merge({"2026-11-12": {"coolH": 2.0, "heatH": 0.0, "cycles": 5}}, {"2026-11-12": 65.0}, date(2026, 11, 13))
        assert hvac_runtime.hvac_report(fresh, None, date(2026, 11, 13))["efficiency"]["status"] == "learning"

    def test_short_cycling(self, tmp_path):
        log = hvac_runtime.HvacLog(None)
        today = date(2026, 11, 13)
        log.merge({(today - timedelta(days=back)).isoformat(): {"coolH": 2.0, "heatH": 0.0, "cycles": 30} for back in range(1, 8)}, {}, today)
        assert hvac_runtime.hvac_report(log, None, today)["shortCycling"] is True

    def test_filter_days_run_hours_and_persistence(self, tmp_path):
        log = self.log(tmp_path, 4.0)
        log.filter_changed = "2026-08-01"
        log.save()
        again = hvac_runtime.HvacLog(tmp_path / "hvac.json")
        status = hvac_runtime.filter_status(again, date(2026, 11, 13))
        assert status["days"] == 104 and status["status"] == "due" and status["runHoursComplete"] is False
        assert status["runHours"] == round(4.0 * 59)
        report = hvac_runtime.hvac_report(again, None, date(2026, 11, 13))
        assert any("104 days" in line for line in report["advice"])

    def test_today_is_never_logged_and_old_days_age_out(self, tmp_path):
        log = hvac_runtime.HvacLog(None)
        today = date(2026, 11, 13)
        log.merge({"2026-11-13": {"coolH": 1.0, "heatH": 0.0, "cycles": 1}, "2025-01-01": {"coolH": 1.0, "heatH": 0.0, "cycles": 1}}, {}, today)
        assert log.days == {}
