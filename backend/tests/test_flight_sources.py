"""Keyless fallback feeds, the daily quota guard, and the last-resort scraper.

These exist because the flight board went blank twice for reasons that had nothing to do with the
flights: an exhausted AirLabs quota, and anonymous OpenSky answering `429`. The module under test
is the fix, so what is asserted here is the fix's contract rather than its implementation:

* a community-feed record must translate into the exact OpenSky state-vector layout the rest of
  `flights.py` indexes positionally -- including the one shape OpenSky never produces, an altitude
  reported as the literal string `"ground"`;
* `Budget` must refuse the call *before* the quota is gone, and must survive a restart, since a
  crash loop is precisely when an in-memory counter would hand the quota back;
* everything degrades to `None`/`{}`/`[]` instead of raising, because every caller treats this
  layer as optional.

No test here may touch the network or the real `/data` volume: the client is always a fake, the
budget file is always redirected into `tmp_path`, and `asyncio.sleep` is recorded rather than slept.
"""

import json
import types

import httpx
import pytest

from app import flight_sources


@pytest.fixture(autouse=True)
def isolated_budget_file(tmp_path, monkeypatch):
    """`_BUDGET_PATH` is resolved at import time; without this a test would write to /data."""
    path = tmp_path / "flight_quota.json"
    monkeypatch.setattr(flight_sources, "_BUDGET_DIR", tmp_path)
    monkeypatch.setattr(flight_sources, "_BUDGET_PATH", path)
    for source in flight_sources.DEFAULT_DAILY_BUDGETS:
        monkeypatch.delenv(f"{source.upper()}_DAILY_BUDGET", raising=False)
    return path


@pytest.fixture(autouse=True)
def clear_throttle_state():
    """Spacing is module state keyed by host, and the locks belong to a since-closed loop."""
    flight_sources._host_next_allowed.clear()
    flight_sources._host_locks.clear()
    yield
    flight_sources._host_next_allowed.clear()
    flight_sources._host_locks.clear()


@pytest.fixture
def recorded_sleeps(monkeypatch):
    """Record the delays throttle asks for instead of serving them, so the suite stays fast."""
    delays = []

    async def fake_sleep(seconds):
        delays.append(seconds)

    monkeypatch.setattr(flight_sources.asyncio, "sleep", fake_sleep)
    return delays


class TestStateRowFromFeed:
    """The translation that lets the fallback feeds drop in behind unchanged downstream logic."""

    AIRBORNE = {
        "hex": "a1b2c3",
        "flight": "SWA2275 ",
        "lat": 30.1975,
        "lon": -97.6664,
        "alt_baro": 35000,
        "alt_geom": 36000,
        "gs": 300,
        "track": 118.4,
        "baro_rate": -1200,
    }

    def test_a_grounded_aircraft_reports_ground_rather_than_an_altitude(self):
        """These feeds send the string "ground" where a number belongs; that means landed."""
        row = flight_sources.state_row_from_feed({**self.AIRBORNE, "alt_baro": "ground"})
        assert row[8] is True
        # Not a bogus 0m, and not "ground" coerced into something numeric-looking.
        assert row[7] is None
        assert row[13] is None

    def test_ground_is_recognised_whatever_its_spacing_or_case(self):
        for raw in ("ground", "GROUND", " Ground "):
            row = flight_sources.state_row_from_feed({**self.AIRBORNE, "alt_baro": raw})
            assert row[8] is True, raw

    def test_an_airborne_aircraft_is_not_marked_on_the_ground(self):
        assert flight_sources.state_row_from_feed(self.AIRBORNE)[8] is False

    def test_position_keeps_openskys_lon_before_lat_ordering(self):
        """Downstream reads these by index, so swapping them would silently mirror the world."""
        row = flight_sources.state_row_from_feed(self.AIRBORNE)
        assert row[5] == pytest.approx(-97.6664)
        assert row[6] == pytest.approx(30.1975)

    def test_speed_altitude_and_climb_rate_arrive_in_si_units(self):
        row = flight_sources.state_row_from_feed(self.AIRBORNE)
        assert row[7] == pytest.approx(35000 / 3.28084)  # feet -> metres
        assert row[13] == pytest.approx(36000 / 3.28084)
        assert row[9] == pytest.approx(300 * 0.514444)  # knots -> metres/second
        assert row[11] == pytest.approx(-1200 / 196.850394)  # feet/minute -> metres/second
        assert row[10] == pytest.approx(118.4)

    def test_a_geometric_climb_rate_stands_in_when_the_barometric_one_is_absent(self):
        record = {**self.AIRBORNE}
        record.pop("baro_rate")
        record["geom_rate"] = 1800
        assert flight_sources.state_row_from_feed(record)[11] == pytest.approx(1800 / 196.850394)

    def test_the_callsign_is_stripped_of_the_feeds_padding(self):
        assert flight_sources.state_row_from_feed(self.AIRBORNE)[1] == "SWA2275"

    def test_a_blank_callsign_is_none_rather_than_whitespace(self):
        row = flight_sources.state_row_from_feed({**self.AIRBORNE, "flight": "   "})
        assert row[1] is None

    def test_the_icao_address_is_normalised(self):
        # Anonymised TIS-B targets arrive with a leading "~"; the rest of the app keys on plain hex.
        assert flight_sources.state_row_from_feed({"hex": " ~A1B2C3 "})[0] == "a1b2c3"

    def test_a_record_without_an_icao_address_is_unusable(self):
        assert flight_sources.state_row_from_feed({"flight": "SWA2275", "lat": 30.0}) is None
        assert flight_sources.state_row_from_feed({"hex": ""}) is None
        assert flight_sources.state_row_from_feed({"hex": "~"}) is None

    def test_missing_fields_become_none_instead_of_raising(self):
        row = flight_sources.state_row_from_feed({"hex": "a1b2c3", "gs": None, "alt_baro": "n/a"})
        assert len(row) == flight_sources.STATE_VECTOR_WIDTH
        assert row[5] is None and row[7] is None and row[9] is None


class TestAircraftInfoFromFeed:
    """The registration/type that ride along with a position, saving a per-aircraft adsbdb call."""

    def test_the_human_readable_description_wins_over_the_icao_code(self):
        """A downstream classifier reads `type`; "B38M" tells it nothing, "BOEING 737..." does."""
        info = flight_sources.aircraft_info_from_feed(
            {"hex": "a1b2c3", "r": "N8646B", "t": "B38M", "desc": "BOEING 737 MAX 8"}
        )
        assert info["type"] == "BOEING 737 MAX 8"
        assert info["icao_type"] == "B38M"
        assert info["registration"] == "N8646B"

    def test_the_icao_code_stands_in_when_there_is_no_description(self):
        info = flight_sources.aircraft_info_from_feed({"hex": "a1b2c3", "r": "N8646B", "t": "B38M"})
        assert info["type"] == "B38M"

    def test_an_empty_description_does_not_shadow_the_icao_code(self):
        info = flight_sources.aircraft_info_from_feed({"r": "N8646B", "t": "B38M", "desc": "   "})
        assert info["type"] == "B38M"

    def test_padded_values_are_stripped(self):
        info = flight_sources.aircraft_info_from_feed({"r": " N8646B ", "t": " B38M ", "desc": " BOEING 737 MAX 8 "})
        assert info == {"registration": "N8646B", "type": "BOEING 737 MAX 8", "icao_type": "B38M"}

    def test_a_record_carrying_no_aircraft_details_yields_nothing(self):
        assert flight_sources.aircraft_info_from_feed({"hex": "a1b2c3", "lat": 30.0}) is None
        assert flight_sources.aircraft_info_from_feed({}) is None


class TestBudget:
    """Stopping before the quota is gone, and staying stopped across a restart."""

    def test_calls_are_allowed_until_the_allowance_is_spent(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "3")
        budget = flight_sources.Budget()
        for expected_remaining in (3, 2, 1):
            assert budget.remaining("airlabs") == expected_remaining
            assert budget.allows("airlabs") is True
            budget.spend("airlabs")
        assert budget.used("airlabs") == 3
        assert budget.remaining("airlabs") == 0
        assert budget.allows("airlabs") is False

    def test_overspending_never_reports_a_negative_allowance(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "1")
        budget = flight_sources.Budget()
        budget.spend("airlabs")
        budget.spend("airlabs")
        assert budget.remaining("airlabs") == 0
        assert budget.allows("airlabs") is False

    def test_the_environment_overrides_the_built_in_limit(self, monkeypatch):
        budget = flight_sources.Budget()
        assert budget.limit("airlabs") == flight_sources.DEFAULT_DAILY_BUDGETS["airlabs"]
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "7")
        assert budget.limit("airlabs") == 7

    def test_a_nonsense_override_falls_back_to_the_built_in_limit(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "lots")
        assert flight_sources.Budget().limit("airlabs") == flight_sources.DEFAULT_DAILY_BUDGETS["airlabs"]

    def test_a_zero_override_switches_a_source_off_entirely(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "0")
        assert flight_sources.Budget().allows("airlabs") is False

    def test_sources_do_not_share_an_allowance(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "1")
        budget = flight_sources.Budget()
        budget.spend("airlabs")
        assert budget.allows("airlabs") is False
        assert budget.allows("flightstats") is True

    def test_an_unknown_source_is_refused_rather_than_unlimited(self):
        assert flight_sources.Budget().allows("some-new-api") is False

    def test_a_restart_picks_up_todays_spending(self, isolated_budget_file):
        """The whole point of persisting: a crash loop must not hand the quota back."""
        first = flight_sources.Budget()
        for _ in range(4):
            first.spend("airlabs")
        assert isolated_budget_file.exists()

        after_restart = flight_sources.Budget()
        assert after_restart.used("airlabs") == 4
        assert after_restart.remaining("airlabs") == flight_sources.DEFAULT_DAILY_BUDGETS["airlabs"] - 4

    def test_counts_saved_for_another_day_are_ignored(self, isolated_budget_file):
        isolated_budget_file.write_text(json.dumps({"day": "1999-12-31", "counts": {"airlabs": 99}}))
        assert flight_sources.Budget().used("airlabs") == 0

    def test_no_saved_file_at_all_simply_starts_fresh(self, isolated_budget_file):
        assert not isolated_budget_file.exists()
        budget = flight_sources.Budget()
        assert budget.used("airlabs") == 0
        assert budget.allows("airlabs") is True

    def test_a_corrupt_saved_file_degrades_instead_of_raising(self, isolated_budget_file):
        isolated_budget_file.write_text("{not json at all")
        budget = flight_sources.Budget()
        assert budget.used("airlabs") == 0
        budget.spend("airlabs")
        assert budget.used("airlabs") == 1

    def test_a_saved_file_of_the_wrong_shape_degrades_instead_of_raising(self, isolated_budget_file):
        for payload in ("[]", '"nope"', '{"day": "%s"}' % flight_sources._today(),
                        '{"day": "%s", "counts": 5}' % flight_sources._today()):
            isolated_budget_file.write_text(payload)
            assert flight_sources.Budget().used("airlabs") == 0, payload

    def test_an_unwritable_volume_leaves_the_budget_per_process(self, monkeypatch, tmp_path):
        """A read-only /data must not take the flight board down with it."""
        monkeypatch.setattr(flight_sources, "_BUDGET_DIR", tmp_path / "nope")
        monkeypatch.setattr(flight_sources, "_BUDGET_PATH", tmp_path / "nope" / "sub" / "quota.json")

        def refuse(*args, **kwargs):
            raise OSError("read-only file system")

        monkeypatch.setattr(flight_sources.Path, "mkdir", refuse)
        budget = flight_sources.Budget()
        budget.spend("airlabs")
        assert budget.used("airlabs") == 1

    def test_the_snapshot_reports_every_source_for_the_status_panel(self, monkeypatch):
        monkeypatch.setenv("AIRLABS_DAILY_BUDGET", "10")
        budget = flight_sources.Budget()
        budget.spend("airlabs")
        snapshot = budget.snapshot()
        assert set(snapshot) == set(flight_sources.DEFAULT_DAILY_BUDGETS)
        assert snapshot["airlabs"] == {"used": 1, "limit": 10, "remaining": 9}

    def test_a_new_utc_day_returns_the_whole_allowance(self, monkeypatch, isolated_budget_file):
        budget = flight_sources.Budget()
        budget.spend("airlabs")
        assert budget.used("airlabs") == 1

        monkeypatch.setattr(flight_sources, "_today", lambda: "2099-01-01")
        assert budget.used("airlabs") == 0
        assert budget.remaining("airlabs") == flight_sources.DEFAULT_DAILY_BUDGETS["airlabs"]


class TestSplitFlightNumber:
    def test_a_two_letter_carrier_splits(self):
        assert flight_sources.split_flight_number("AA193") == ("AA", "193")

    def test_a_three_letter_carrier_splits(self):
        assert flight_sources.split_flight_number("SWA2275") == ("SWA", "2275")

    def test_case_and_padding_do_not_matter(self):
        assert flight_sources.split_flight_number("  aa193 ") == ("AA", "193")
        assert flight_sources.split_flight_number("AA 193") == ("AA", "193")

    def test_junk_is_refused_rather_than_scraped_for(self):
        for junk in (None, "", "   ", "193", "AA", "AAAA193", "N172SP", "AA12345", "AA-193"):
            assert flight_sources.split_flight_number(junk) is None, junk


class TestParseFlightStats:
    """Reading the page's hydration blob, which is undocumented and therefore assumed hostile."""

    def payload(self, **schedule_overrides):
        schedule = {
            "scheduledDepartureUTC": "2026-08-04T19:35:00.000Z",
            "estimatedActualDepartureUTC": "2026-08-04T19:52:00.000Z",
            "estimatedActualDepartureTitle": "Actual",
            "scheduledArrivalUTC": "2026-08-04T22:10:00.000Z",
            "estimatedActualArrivalUTC": "2026-08-04T22:28:00.000Z",
        }
        schedule.update(schedule_overrides)
        return {
            "props": {
                "initialState": {
                    "flightTracker": {
                        "flight": {
                            "schedule": schedule,
                            "status": {"status": "En Route", "delayStatus": {"minutes": 17}},
                            "departureAirport": {
                                "iata": "AUS",
                                "fs": "AUS",
                                "city": "Austin",
                                "gate": "12",
                                "terminal": "S",
                                "times": {"scheduled": {"time24": "14:35", "timezone": "CDT"}},
                            },
                            "arrivalAirport": {
                                "iata": "LAX",
                                "fs": "LAX",
                                "city": "Los Angeles",
                                "gate": "44B",
                                "terminal": "1",
                                "baggage": "4",
                                "times": {"scheduled": {"time24": "16:10", "timezone": "PDT"}},
                            },
                            "positional": {"flexTrack": {"callsign": " swa2275 ", "tailNumber": "n8646b"}},
                        }
                    }
                }
            }
        }

    def test_the_details_a_person_meeting_a_flight_wants_are_extracted(self):
        parsed = flight_sources.parse_flightstats(self.payload())
        assert parsed["depGate"] == "12"
        assert parsed["depTerminal"] == "S"
        assert parsed["arrGate"] == "44B"
        assert parsed["arrTerminal"] == "1"
        assert parsed["baggage"] == "4"
        assert parsed["delayMin"] == 17
        assert parsed["status"] == "en route"
        assert parsed["source"] == "flightstats"

    def test_the_route_and_local_times_are_extracted(self):
        parsed = flight_sources.parse_flightstats(self.payload())
        assert (parsed["fromCode"], parsed["fromCity"]) == ("AUS", "Austin")
        assert (parsed["toCode"], parsed["toCity"]) == ("LAX", "Los Angeles")
        assert parsed["depTimeLocal"] == "14:35 CDT"
        assert parsed["arrTimeLocal"] == "16:10 PDT"

    def test_the_live_track_hands_back_a_callsign_and_registration(self):
        """This is the bridge to the position feeds, so it has to come out normalised."""
        parsed = flight_sources.parse_flightstats(self.payload())
        assert parsed["_callsign"] == "SWA2275"
        assert parsed["reg"] == "N8646B"

    def test_an_actual_departure_time_is_reported_as_actual(self):
        parsed = flight_sources.parse_flightstats(self.payload())
        assert parsed["depActual"] == "2026-08-04T19:52:00.000Z"
        assert parsed["depScheduled"] == "2026-08-04T19:35:00.000Z"

    def test_an_estimated_departure_time_is_never_presented_as_actual(self):
        """The source reuses one field for both; showing an estimate as actual would be a lie."""
        parsed = flight_sources.parse_flightstats(self.payload(estimatedActualDepartureTitle="Estimated"))
        assert "depActual" not in parsed
        assert parsed["arrEstimated"] == "2026-08-04T22:28:00.000Z"

    def test_absent_fields_are_omitted_rather_than_reported_as_null(self):
        payload = self.payload()
        flight = payload["props"]["initialState"]["flightTracker"]["flight"]
        flight["departureAirport"] = {"fs": "AUS"}
        flight["arrivalAirport"] = {}
        flight["positional"] = {}
        parsed = flight_sources.parse_flightstats(payload)
        assert parsed["fromCode"] == "AUS"  # falls back to the "fs" code
        assert "depGate" not in parsed
        assert "baggage" not in parsed
        assert "_callsign" not in parsed
        assert None not in parsed.values()

    def test_a_payload_that_is_not_the_expected_page_yields_nothing(self):
        for payload in ({}, {"props": {}}, {"props": {"initialState": {}}},
                        {"props": {"initialState": {"flightTracker": {}}}},
                        {"props": {"initialState": {"flightTracker": {"flight": None}}}},
                        {"props": {"initialState": {"flightTracker": {"flight": "unavailable"}}}}):
            assert flight_sources.parse_flightstats(payload) == {}, payload

    def test_a_null_inside_the_page_state_yields_nothing(self):
        # An explicit null satisfies `.get(key, {})` while still being unsubscriptable, so every
        # level of the walk has to tolerate one.
        for payload in ({"props": None},
                        {"props": {"initialState": None}},
                        {"props": {"initialState": {"flightTracker": None}}}):
            assert flight_sources.parse_flightstats(payload) == {}, payload


class TestThrottle:
    """The feeds document 1 request/second and ask non-feeders to be gentle."""

    URL_A = "https://api.adsb.lol/v2/hex/a1b2c3"
    URL_A2 = "https://api.adsb.lol/v2/callsign/SWA2275"
    URL_B = "https://opendata.adsb.fi/api/v2/hex/a1b2c3"

    def test_the_first_call_to_a_host_is_not_delayed(self, recorded_sleeps):
        _run(flight_sources.throttle(self.URL_A))
        assert recorded_sleeps == []

    def test_a_second_call_to_the_same_host_waits_out_the_spacing(self, recorded_sleeps):
        async def twice():
            await flight_sources.throttle(self.URL_A)
            await flight_sources.throttle(self.URL_A2)

        _run(twice())
        assert len(recorded_sleeps) == 1
        assert 0 < recorded_sleeps[0] <= flight_sources.MIN_REQUEST_SPACING_S
        assert recorded_sleeps[0] == pytest.approx(flight_sources.MIN_REQUEST_SPACING_S, abs=0.2)

    def test_one_slow_feed_does_not_stall_the_others(self, recorded_sleeps):
        """Spacing is deliberately per host: the fallback chain would be pointless otherwise."""

        async def both_hosts():
            await flight_sources.throttle(self.URL_A)
            await flight_sources.throttle(self.URL_B)

        _run(both_hosts())
        assert recorded_sleeps == []
        assert set(flight_sources._host_next_allowed) == {"api.adsb.lol", "opendata.adsb.fi"}

    def test_concurrent_callers_to_one_host_queue_instead_of_firing_together(self, recorded_sleeps):
        async def three_at_once():
            import asyncio as real_asyncio

            await real_asyncio.gather(*(flight_sources.throttle(self.URL_A) for _ in range(3)))

        _run(three_at_once())
        # The first goes straight through; the other two each waited their turn.
        assert len(recorded_sleeps) == 2


class TestFeedFallbackChain:
    """One feed being down has to be invisible, and no feed may ever raise at the caller."""

    def test_the_first_feed_that_answers_wins_and_the_rest_are_left_alone(self, recorded_sleeps):
        client, urls = _fake_client({"ac": [{"hex": "a1b2c3", "flight": "SWA2275 ", "lat": 30.2, "lon": -97.7}]})
        rows, records, feed = _run(
            flight_sources.feed_states_in_radius(client, 30.2, -97.7, 100.0, _record_errors([]))
        )
        assert feed == "adsb.lol"
        assert len(urls) == 1
        assert rows[0][1] == "SWA2275"
        assert records[0]["hex"] == "a1b2c3"

    def test_a_dead_feed_falls_through_to_the_next_one(self, recorded_sleeps):
        errors = []

        async def get(url, **kwargs):
            if "adsb.lol" in url:
                raise httpx.ConnectError("boom")
            return _FakeResponse({"aircraft": [{"hex": "a1b2c3", "lat": 30.2, "lon": -97.7}]})

        rows, _, feed = _run(
            flight_sources.feed_states_in_radius(
                types.SimpleNamespace(get=get), 30.2, -97.7, 100.0, _record_errors(errors)
            )
        )
        assert feed == "adsb.fi"
        assert len(rows) == 1
        assert errors == [("adsb:adsb.lol", "boom")]

    def test_every_feed_failing_reports_nothing_rather_than_raising(self, recorded_sleeps):
        errors = []

        async def get(url, **kwargs):
            raise httpx.ConnectError("boom")

        result = _run(
            flight_sources.feed_states_in_radius(
                types.SimpleNamespace(get=get), 30.2, -97.7, 100.0, _record_errors(errors)
            )
        )
        assert result == ([], [], None)
        assert len(errors) == len(flight_sources.ADSB_FEEDS)

    def test_the_radius_is_clamped_to_what_the_feeds_accept(self, recorded_sleeps):
        client, urls = _fake_client({"ac": [{"hex": "a1b2c3"}]})
        _run(flight_sources.feed_states_in_radius(client, 30.2, -97.7, 40_000.0, _record_errors([])))
        assert urls[0].endswith("/%d" % flight_sources.MAX_FEED_RADIUS_NM)

        urls.clear()
        flight_sources._host_next_allowed.clear()
        _run(flight_sources.feed_states_in_radius(client, 30.2, -97.7, 0.0, _record_errors([])))
        assert urls[0].endswith("/1")

    def test_a_callsign_is_asked_of_the_feed_directly(self, recorded_sleeps):
        """Resolving a pin against OpenSky means downloading the planet; the feeds just answer."""
        client, urls = _fake_client({"ac": [{"hex": "a1b2c3", "flight": "SWA2275", "r": "N8646B", "t": "B38M"}]})
        row, record, feed = _run(flight_sources.feed_lookup(client, "callsign", "swa2275", _record_errors([])))
        assert urls[0].endswith("/callsign/SWA2275")
        assert row[0] == "a1b2c3"
        assert flight_sources.aircraft_info_from_feed(record)["registration"] == "N8646B"
        assert feed == "adsb.lol"

    def test_a_hex_lookup_uses_the_hex_route_in_lower_case(self, recorded_sleeps):
        client, urls = _fake_client({"ac": [{"hex": "a1b2c3"}]})
        _run(flight_sources.feed_lookup(client, "hex", "A1B2C3", _record_errors([])))
        assert urls[0].endswith("/hex/a1b2c3")

    def test_an_unknown_aircraft_is_reported_as_absent(self, recorded_sleeps):
        client, _ = _fake_client({"ac": []})
        assert _run(flight_sources.feed_lookup(client, "hex", "a1b2c3", _record_errors([]))) == (None, None, None)

    def test_a_feed_answering_with_something_other_than_json_is_not_fatal(self, recorded_sleeps):
        errors = []

        async def get(url, **kwargs):
            return _FakeResponse(None, raises=ValueError("Expecting value"))

        result = _run(
            flight_sources.feed_states_in_radius(
                types.SimpleNamespace(get=get), 30.2, -97.7, 100.0, _record_errors(errors)
            )
        )
        assert result == ([], [], None)
        assert len(errors) == len(flight_sources.ADSB_FEEDS)


class TestScheduleFromFlightStats:
    """The last resort: an undocumented blob inside a public page, so failure must be quiet."""

    def html_for(self, payload):
        return "<html><script>window.__NEXT_DATA__ = %s;</script></html>" % json.dumps(payload)

    def test_a_readable_page_yields_the_schedule(self, recorded_sleeps):
        payload = TestParseFlightStats().payload()
        client, urls = _fake_client(text=self.html_for(payload))
        result = _run(flight_sources.schedule_from_flightstats(client, "WN2275", _record_errors([])))
        assert urls == ["https://www.flightstats.com/v2/flight-tracker/WN/2275"]
        assert result["depGate"] == "12"
        assert result["_callsign"] == "SWA2275"

    def test_an_unparseable_flight_number_never_reaches_the_network(self, recorded_sleeps):
        client, urls = _fake_client(text="")
        assert _run(flight_sources.schedule_from_flightstats(client, "N172SP", _record_errors([]))) == {}
        assert urls == []

    def test_a_page_without_the_blob_is_reported_and_yields_nothing(self, recorded_sleeps):
        errors = []
        client, _ = _fake_client(text="<html>please enable javascript</html>")
        assert _run(flight_sources.schedule_from_flightstats(client, "WN2275", _record_errors(errors))) == {}
        assert errors[0][0] == "flightstats"

    def test_an_http_failure_is_reported_and_yields_nothing(self, recorded_sleeps):
        errors = []

        async def get(url, **kwargs):
            raise httpx.HTTPStatusError("403", request=None, response=None)

        assert _run(
            flight_sources.schedule_from_flightstats(
                types.SimpleNamespace(get=get), "WN2275", _record_errors(errors)
            )
        ) == {}
        assert errors == [("flightstats", "403")]


class _FakeResponse:
    def __init__(self, payload=None, text="", raises=None):
        self._payload = payload
        self._raises = raises
        self.text = text

    def raise_for_status(self):
        return None

    def json(self):
        if self._raises:
            raise self._raises
        return self._payload


def _fake_client(payload=None, text=""):
    """A stand-in for httpx.AsyncClient that records the URLs asked for and answers from memory."""
    urls = []

    async def get(url, **kwargs):
        urls.append(url)
        return _FakeResponse(payload, text=text)

    return types.SimpleNamespace(get=get), urls


def _record_errors(sink):
    def on_error(source, detail):
        sink.append((source, detail))

    return on_error


def _run(coro):
    import asyncio

    return asyncio.run(coro)
