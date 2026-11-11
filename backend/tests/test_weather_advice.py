"""Forecast advice, against hand-built hourly forecasts so each rule is checked in isolation.

`NOW` is 07:00 on Tuesday 2026-11-10 at a UTC+0 location; the forecast spans yesterday
through three days out, like the real request (`past_days=1`, `forecast_days=4`).
"""

from datetime import datetime, timedelta, timezone

import pytest

from app import weather_advice

NOW_LOCAL = datetime(2026, 11, 10, 7, 0)
NOW = NOW_LOCAL.replace(tzinfo=timezone.utc).timestamp()
CALM = dict(temp=12.0, feels=12.0, humidity=70.0, dew=6.0, chance=0, precip=0.0, snow=0.0, code=2, wind=8.0, gust=15.0, uv=2.0)


def forecast(overrides=None, daily_overrides=None) -> dict:
    """Five days of calm hourly weather; `overrides(day, hour)` returns fields to change."""
    start = datetime(2026, 11, 9)
    hourly = {key: [] for key in (
        "time", "temperature_2m", "apparent_temperature", "relative_humidity_2m", "dew_point_2m",
        "precipitation_probability", "precipitation", "snowfall", "weather_code", "wind_speed_10m",
        "wind_gusts_10m", "uv_index",
    )}
    for step in range(5 * 24):
        at = start + timedelta(hours=step)
        row = dict(CALM)
        if overrides:
            row.update(overrides((at.date() - NOW_LOCAL.date()).days, at.hour) or {})
        hourly["time"].append(at.strftime("%Y-%m-%dT%H:%M"))
        hourly["temperature_2m"].append(row["temp"])
        hourly["apparent_temperature"].append(row["feels"])
        hourly["relative_humidity_2m"].append(row["humidity"])
        hourly["dew_point_2m"].append(row["dew"])
        hourly["precipitation_probability"].append(row["chance"])
        hourly["precipitation"].append(row["precip"])
        hourly["snowfall"].append(row["snow"])
        hourly["weather_code"].append(row["code"])
        hourly["wind_speed_10m"].append(row["wind"])
        hourly["wind_gusts_10m"].append(row["gust"])
        hourly["uv_index"].append(row["uv"])
    dates = [(start + timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(5)]
    daily = {
        "time": dates,
        "weather_code": [2] * 5,
        "temperature_2m_max": [14.0] * 5,
        "temperature_2m_min": [6.0] * 5,
        "precipitation_probability_max": [10] * 5,
        "sunrise": [f"{date}T06:58" for date in dates],
        "sunset": [f"{date}T16:41" for date in dates],
        "daylight_duration": [35000.0, 34880.0, 34760.0, 34640.0, 34520.0],
    }
    daily.update(daily_overrides or {})
    return {"utc_offset_seconds": 0, "hourly": hourly, "daily": daily}


def advice(overrides=None, imperial=False):
    return weather_advice.build_advice(forecast(overrides), imperial, NOW)


def ids(items):
    return [item.id for item in items]


def test_calm_weather_says_nothing():
    assert advice() == []


def test_heavy_snow_tomorrow_says_move_the_car():
    items = advice(lambda day, hour: {"snow": 0.8, "precip": 0.8, "temp": -2.0} if day == 1 and 6 <= hour < 20 else None)
    snow = next(item for item in items if item.id == "snow:tomorrow")
    assert snow.severity == "warning"
    assert "Heavy snow tomorrow" in snow.title
    assert "car" in snow.detail


def test_severe_snow_is_critical_and_formats_in_inches():
    items = advice(lambda day, hour: {"snow": 2.0, "precip": 2.0, "temp": -3.0} if day == 1 and 6 <= hour < 18 else None, imperial=True)
    snow = next(item for item in items if item.id == "snow:tomorrow")
    assert snow.severity == "critical"
    assert snow.title.endswith("in")


def test_windy_afternoon_says_secure_the_yard_with_peak_time():
    items = advice(lambda day, hour: {"gust": 65.0} if day == 0 and hour == 15 else None)
    wind = next(item for item in items if item.id == "wind:today")
    assert wind.severity == "warning"
    assert "3 pm" in wind.title
    assert "patio furniture" in wind.detail


def test_damaging_wind_adds_power_and_trees_advice():
    items = advice(lambda day, hour: {"gust": 95.0} if day == 1 and hour == 10 else None)
    wind = next(item for item in items if item.id == "wind:tomorrow")
    assert wind.severity == "critical"
    assert "trees" in wind.detail


def test_breezy_november_day_is_a_leaf_day():
    items = advice(lambda day, hour: {"gust": 45.0} if day == 0 and hour == 13 else None)
    assert "leaves:today" in ids(items)


def test_hard_freeze_tonight_means_hoses_and_pipes():
    items = advice(lambda day, hour: {"temp": -6.0} if day == 1 and 2 <= hour <= 6 else None)
    freeze = next(item for item in items if item.id == "freeze:tonight")
    assert freeze.severity == "warning"
    assert "hoses" in freeze.detail and "pipes" in freeze.detail


def test_hot_day_and_extreme_heat():
    hot = advice(lambda day, hour: {"temp": 31.0, "feels": 32.0} if day == 0 and 12 <= hour <= 16 else None)
    assert next(item for item in hot if item.id == "heat:today").severity == "warning"
    extreme = advice(lambda day, hour: {"temp": 36.0, "feels": 39.0} if day == 0 and 12 <= hour <= 16 else None)
    item = next(item for item in extreme if item.id == "heat:today")
    assert item.severity == "critical"
    assert "pets" in item.detail


def test_muggy_day_suggests_dehumidifier():
    items = advice(lambda day, hour: {"dew": 21.5, "humidity": 85.0} if day == 0 and 10 <= hour <= 18 else None)
    humid = next(item for item in items if item.id == "humid:today")
    assert "dehumidifier" in humid.detail


def test_rain_today_names_the_start_hour():
    items = advice(lambda day, hour: {"precip": 1.0, "chance": 80} if day == 0 and 14 <= hour <= 18 else None)
    rain = next(item for item in items if item.id == "rain:today")
    assert rain.title == "Rain today from 2 pm"


def test_thunderstorms_tomorrow():
    items = advice(lambda day, hour: {"code": 95, "precip": 3.0, "chance": 70} if day == 1 and hour == 17 else None)
    assert "storm:tomorrow" in ids(items)


def test_same_weather_today_and_tonight_is_one_heads_up():
    items = advice(lambda day, hour: {"gust": 70.0} if (day == 0 and hour >= 15) or (day == 1 and hour <= 6) else None)
    assert "wind:today" in ids(items)
    assert "wind:tonight" not in ids(items)


def test_days_further_out_only_raise_real_warnings():
    items = advice(lambda day, hour: {"precip": 0.5, "chance": 70} if day == 2 and 8 <= hour <= 14 else None)
    assert not any(item.window == "day2" for item in items)
    items = advice(lambda day, hour: {"gust": 70.0} if day == 2 and hour == 12 else None)
    assert next(item for item in items if item.window == "day2").when == "Thursday"


def test_lovely_evening_and_free_cooling():
    evening = advice(lambda day, hour: {"temp": 20.0, "feels": 20.0} if day == 0 and 18 <= hour <= 21 else None)
    assert "nice-evening:today" in ids(evening)
    cooling = advice(lambda day, hour: (
        {"temp": 29.0, "feels": 29.0} if day == 0 and 12 <= hour <= 16
        else {"temp": 15.0, "feels": 15.0} if day == 1 and hour <= 6 else None
    ))
    assert "cool-night:tonight" in ids(cooling)


def test_much_colder_tomorrow():
    items = advice(lambda day, hour: {"temp": 22.0} if day == 0 and 12 <= hour <= 15 else {"temp": 6.0} if day == 1 else None)
    assert "colder:tomorrow" in ids(items)


def test_today_summary_reports_daylight_change():
    summary = weather_advice.today_summary(forecast(), imperial=True, now=NOW)
    assert summary["date"] == "2026-11-10"
    assert summary["sunrise"] == "6:58 am"
    assert summary["sunset"] == "4:41 pm"
    assert summary["daylightChange"] == "2 min less daylight than yesterday"
    assert summary["high"] == "57°F"


def test_week_ahead_starts_tomorrow():
    days = weather_advice.week_ahead(forecast(), imperial=False, now=NOW)
    assert [day["label"] for day in days] == ["Tomorrow", "Thursday", "Friday"]


@pytest.mark.parametrize("imperial, expected", [(True, "50°F"), (False, "10°C")])
def test_units(imperial, expected):
    assert weather_advice.Units(imperial).temp(10.0) == expected
