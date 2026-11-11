from app import garden, weekly
from tests.test_weather_advice import NOW, forecast


def plant(entity_id: str, moisture: float, name: str) -> dict:
    return {"entity_id": entity_id, "state": str(moisture), "attributes": {"friendly_name": name, "unit_of_measurement": "%"}}


MAPLE = plant("sensor.lawn_plant_sensor_maple_humidity", 14, "Lawn plant sensor maple humidity")
MAGNOLIA = plant("sensor.lawn_plant_sensor_magnolia_humidity", 45, "Lawn plant sensor magnolia humidity")


class TestGarden:
    def test_dry_plant_with_rain_coming_is_left_alone(self):
        rainy = forecast(lambda day, hour: {"precip": 2.0, "chance": 90} if day == 0 and 19 <= hour <= 23 else None)
        [item] = garden.garden_advice([MAPLE, MAGNOLIA], rainy, imperial=False, now=NOW)
        assert item.title == "Skip watering Lawn maple"
        assert "10 mm of rain is due tonight" in item.detail

    def test_dry_plant_on_a_dry_hot_day_is_watered_early(self):
        hot = forecast(lambda day, hour: {"temp": 32.0} if day == 0 and 13 <= hour <= 16 else None)
        [item] = garden.garden_advice([MAPLE], hot, imperial=False, now=NOW)
        assert item.title == "Water Lawn maple today"
        assert "before the heat" in item.detail

    def test_very_dry_is_a_warning_and_wet_plants_say_nothing(self):
        [item] = garden.garden_advice([plant("sensor.garden_soil_moisture", 6, "Garden soil moisture")], forecast(), imperial=False, now=NOW)
        assert item.severity == "warning"
        assert garden.garden_advice([MAGNOLIA], forecast(), imperial=False, now=NOW) == []

    def test_pause_the_sprinklers_when_rain_will_do_it(self):
        rainy = forecast(lambda day, hour: {"precip": 3.0, "chance": 90} if day == 0 and 12 <= hour <= 14 else None)
        sprinkler = {"entity_id": "switch.front_sprinkler", "state": "off", "attributes": {}}
        items = garden.garden_advice([sprinkler], rainy, imperial=True, now=NOW)
        assert [item.title for item in items] == ["Pause the sprinklers"]


DAY = 86400.0


def entry(rule: str, days_ago: float, hours: float = 1.0, name: str = "Den lamp", detail: str = "", entity_id: str = "light.den") -> dict:
    start = NOW - days_ago * DAY
    return {"rule": rule, "category": "light", "severity": "warning", "entityId": entity_id, "name": name,
            "detail": detail, "startedAt": start, "endedAt": start + hours * 3600}


class TestWeekly:
    def test_counts_this_week_against_last(self):
        journal = [
            entry("light_left_on", 1, hours=3), entry("light_left_on", 2, hours=4),
            entry("garage_open", 3, name="Garage", detail="Open after dark (40m)", entity_id="cover.garage"),
            entry("light_left_on", 9), entry("light_left_on", 10), entry("lock_unlocked", 11, detail="Unlocked after dark (1h)", entity_id="lock.back"),
            entry("light_left_on", 12),
        ]
        actions = [{"entityId": "light.den", "name": "Den lamp", "service": "light.turn_off", "at": NOW - DAY}]
        report = weekly.weekly_report(journal, actions, NOW)
        stats = {stat["key"]: stat for stat in report["stats"]}
        assert report["headline"] == "A calmer week: 3 things noticed, down from 4."
        assert (stats["lights"]["value"], stats["lights"]["previous"]) == (2, 3)
        assert stats["lights"]["detail"] == "7 h in all"
        assert (stats["garage"]["value"], stats["locks"]["previous"]) == (1, 1)
        assert stats["autoOff"]["value"] == 1
        assert report["top"][0] == {"name": "Den lamp", "count": 2}
        assert "Garage open after dark: 1" in weekly.summary_text(report)

    def test_quiet_week(self):
        assert weekly.weekly_report([], [], NOW)["headline"] == "A quiet week: nothing needed attention."
