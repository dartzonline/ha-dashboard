"""Multi-flight pin bookkeeping.

These cover the rules that decide when a pinned flight stays on the board, because the bug that
prompted them was a flight quietly disappearing mid-air: a pin must survive a gap in OpenSky
coverage and must not be retired by a schedule feed still reporting the previous leg as landed.
"""

import time
import types

import httpx
import pytest

from app import flights


@pytest.fixture(autouse=True)
def clear_pins():
    flights._track.clear()
    yield
    flights._track.clear()


def pin(**overrides):
    base = {
        "key": "SWA771",
        "query": "SWA771",
        "icao_callsign": "SWA771",
        "iata_number": "WN771",
        "icao24": None,
        "resolved_at": 0.0,
        "pinned_at": time.time(),
        "seen_at": None,
        "landed_at": None,
    }
    return {**base, **overrides}


class TestPinExpiry:
    def test_a_flight_seen_airborne_survives_a_coverage_gap(self):
        """The reported bug: losing the state vector for a while must not drop the pin."""
        now = time.time()
        seen = pin(pinned_at=now - 40_000, seen_at=now - 9_000)
        assert flights._pin_is_expired(seen, now) is False

    def test_a_landed_flight_lingers_then_retires(self):
        now = time.time()
        just_landed = pin(seen_at=now - 100, landed_at=now - 60)
        assert flights._pin_is_expired(just_landed, now) is False

        long_landed = pin(seen_at=now - 100, landed_at=now - flights.TRACK_LINGER_S - 1)
        assert flights._pin_is_expired(long_landed, now) is True

    def test_a_landed_flight_is_still_on_the_board_hours_later(self):
        """Someone meeting an arrival checks the gate and baggage claim after it is on the ground, so
        a landed flight has to outlast the landing by hours -- half an hour retired them first."""
        now = time.time()
        landed_three_hours_ago = pin(seen_at=now - 11_000, landed_at=now - 10_800)
        assert flights._pin_is_expired(landed_three_hours_ago, now) is False

    def test_a_flight_never_seen_is_given_up_on_eventually(self):
        now = time.time()
        fresh = pin(pinned_at=now - 60)
        assert flights._pin_is_expired(fresh, now) is False

        ancient = pin(pinned_at=now - flights.TRACK_UNSEEN_S - 1)
        assert flights._pin_is_expired(ancient, now) is True

    def test_landing_retires_a_flight_even_if_it_was_never_seen_late(self):
        now = time.time()
        landed = pin(pinned_at=now - 60, seen_at=None, landed_at=now - flights.TRACK_LINGER_S - 1)
        assert flights._pin_is_expired(landed, now) is True


class TestPinBoard:
    def test_pinning_adds_rather_than_replaces(self, monkeypatch):
        monkeypatch.setattr(flights, "_build_track_board", _stub_board)
        _run(flights.pin_track(flights.TrackRequest(query="AA100")))
        _run(flights.pin_track(flights.TrackRequest(query="UA200")))
        assert list(flights._track) == ["AAL100", "UAL200"]

    def test_pinning_the_same_flight_twice_keeps_one_entry(self, monkeypatch):
        monkeypatch.setattr(flights, "_build_track_board", _stub_board)
        _run(flights.pin_track(flights.TrackRequest(query="AA100")))
        _run(flights.pin_track(flights.TrackRequest(query="aa100")))
        assert list(flights._track) == ["AAL100"]

    def test_the_board_is_capped_and_evicts_the_oldest(self, monkeypatch):
        monkeypatch.setattr(flights, "_build_track_board", _stub_board)
        for n in range(flights.MAX_TRACKED_FLIGHTS + 1):
            _run(flights.pin_track(flights.TrackRequest(query=f"AA{100 + n}")))
        assert len(flights._track) == flights.MAX_TRACKED_FLIGHTS
        assert "AAL100" not in flights._track
        assert f"AAL{100 + flights.MAX_TRACKED_FLIGHTS}" in flights._track

    def test_unpinning_one_flight_leaves_the_rest(self, monkeypatch):
        monkeypatch.setattr(flights, "_build_track_board", _stub_board)
        _run(flights.pin_track(flights.TrackRequest(query="AA100")))
        _run(flights.pin_track(flights.TrackRequest(query="UA200")))
        _run(flights.unpin_track(query="AA100"))
        assert list(flights._track) == ["UAL200"]

    def test_unpinning_without_a_query_clears_the_board(self, monkeypatch):
        monkeypatch.setattr(flights, "_build_track_board", _stub_board)
        _run(flights.pin_track(flights.TrackRequest(query="AA100")))
        _run(flights.pin_track(flights.TrackRequest(query="UA200")))
        _run(flights.unpin_track())
        assert flights._track == {}


class TestRoutePayload:
    """The Track page draws a real map now, which needs the endpoints' coordinates, not just codes."""

    def test_both_ends_carry_their_coordinates(self):
        payload = flights.route_payload(
            {"code": "LAX", "city": "Los Angeles", "lat": 33.94, "lon": -118.41},
            {"code": "AUS", "city": "Austin", "lat": 30.19, "lon": -97.67},
        )
        assert payload == {
            "fromCode": "LAX", "fromCity": "Los Angeles", "fromLat": 33.94, "fromLon": -118.41,
            "toCode": "AUS", "toCity": "Austin", "toLat": 30.19, "toLon": -97.67,
        }

    def test_a_half_resolved_route_still_reports_the_side_it_knows(self):
        payload = flights.route_payload({"code": "LAX", "city": "Los Angeles", "lat": 33.94, "lon": -118.41}, None)
        assert payload["fromCode"] == "LAX"
        assert payload["toCode"] is None
        assert payload["toLat"] is None

    def test_an_airport_without_coordinates_reports_none_rather_than_guessing(self):
        # resolve_airport() returns lat/lon of None for a field outside the bundled table.
        payload = flights.route_payload(flights.resolve_airport("KZZZ"), None)
        assert payload["fromCode"] == "ZZZ"
        assert payload["fromLat"] is None

    def test_no_route_at_all_stays_none(self):
        assert flights.route_payload(None, None) is None


class TestOperatedBy:
    """Finding a flight that is in the sky under the operating airline's callsign.

    AA3456 flies as ENY3456: an exact-callsign scan leaves those pinned flights stuck on "Awaiting"
    forever even though the aircraft is right there in the state vector.
    """

    LAX = {"code": "LAX", "city": "Los Angeles", "lat": 33.94, "lon": -118.41}
    AUS = {"code": "AUS", "city": "Austin", "lat": 30.19, "lon": -97.67}

    def row(self, callsign, lat, lon, track, on_ground=False):
        # OpenSky state vector layout: [icao24, callsign, ..., lon(5), lat(6), ..., on_ground(8), ..., track(10)]
        state = [None] * 17
        state[0], state[1], state[5], state[6], state[8], state[10] = "abc123", callsign, lon, lat, on_ground, track
        return state

    def test_the_same_number_under_a_partner_callsign_on_the_route_matches(self):
        midway = self.row("ENY3456", 32.0, -108.0, 100)
        assert flights.operated_by(midway, "AAL3456", self.LAX, self.AUS) is True

    def test_a_different_flight_number_never_matches(self):
        assert flights.operated_by(self.row("ENY9999", 32.0, -108.0, 100), "AAL3456", self.LAX, self.AUS) is False

    def test_the_same_number_somewhere_else_entirely_is_refused(self):
        """Every airline has a flight 3456; the number alone proves nothing."""
        over_europe = self.row("BAW3456", 50.0, 5.0, 100)
        assert flights.operated_by(over_europe, "AAL3456", self.LAX, self.AUS) is False

    def test_the_return_leg_flying_the_corridor_backwards_is_refused(self):
        heading_back = self.row("ENY3456", 32.0, -108.0, 280)
        assert flights.operated_by(heading_back, "AAL3456", self.LAX, self.AUS) is False

    def test_an_aircraft_on_the_ground_is_refused(self):
        parked = self.row("ENY3456", 32.0, -108.0, 100, on_ground=True)
        assert flights.operated_by(parked, "AAL3456", self.LAX, self.AUS) is False

    def test_without_a_known_route_there_is_nothing_to_check_against(self):
        candidate = self.row("ENY3456", 32.0, -108.0, 100)
        assert flights.operated_by(candidate, "AAL3456", None, None) is False
        assert flights.operated_by(candidate, "AAL3456", self.LAX, None) is False

    def test_the_pinned_callsign_itself_is_not_a_partner_match(self):
        """The exact match is the caller's job and outranks this; here it must not double-count."""
        assert flights.operated_by(self.row("AAL3456", 32.0, -108.0, 100), "AAL3456", self.LAX, self.AUS) is False

    def test_flight_number_extraction(self):
        assert flights.flight_number_of("AAL9195") == "9195"
        assert flights.flight_number_of("ENY3456") == "3456"
        assert flights.flight_number_of("AAL799R") == "799"
        # Registrations are not flight numbers: a Cessna's tail must not read as flight 172.
        assert flights.flight_number_of("N172SP") is None
        assert flights.flight_number_of("D9195") is None
        assert flights.flight_number_of("AAL") is None
        assert flights.flight_number_of(None) is None


class TestAwaitReason:
    """A bare "Awaiting" is indistinguishable from a broken tracker, so it has to say which it is."""

    def test_a_codeshare_points_at_the_schedule_key_that_would_resolve_it(self):
        reason = flights.await_reason("AAL9195", None, has_route=True, has_schedule_key=False)
        assert "AAL9195" in reason
        assert "codeshare" in reason
        assert "AIRLABS_KEY" in reason

    def test_with_a_schedule_key_it_stops_recommending_one(self):
        reason = flights.await_reason("AAL9195", None, has_route=True, has_schedule_key=True)
        assert "AIRLABS_KEY" not in reason

    def test_a_known_aircraft_that_went_quiet_is_a_different_answer(self):
        reason = flights.await_reason("AAL100", "a1b2c3", has_route=True, has_schedule_key=False)
        assert "not reported a position" in reason

    def test_an_unknown_flight_number_says_so(self):
        reason = flights.await_reason("XYZ1", None, has_route=False, has_schedule_key=False)
        assert "no route is on file" in reason

    def test_a_rate_limited_feed_is_blamed_before_the_flight(self):
        """Anonymous OpenSky answers 429 constantly; that is not the flight's fault."""
        reason = flights.await_reason(
            "AAL3656", "a1b2c3", has_route=True, has_schedule_key=False, feed_failing=True,
        )
        assert "position feed" in reason
        assert "OPENSKY_CLIENT_ID" in reason

    def test_with_opensky_credentials_it_stops_recommending_them(self):
        reason = flights.await_reason(
            "AAL3656", "a1b2c3", has_route=True, has_schedule_key=False,
            feed_failing=True, has_opensky_key=True,
        )
        assert "OPENSKY_CLIENT_ID" not in reason


class TestStateRowFallback:
    """A rate-limited feed must not retire a flight that is demonstrably still flying."""

    def setup_method(self):
        flights._state_row_cache.clear()
        flights._last_upstream_error.clear()

    teardown_method = setup_method

    def test_a_recent_failure_is_reported_as_the_feed_failing(self):
        assert flights.upstream_failing("opensky_states") is False
        flights._note_upstream("opensky_states", "HTTP 429")
        assert flights.upstream_failing("opensky_states") is True

    def test_an_old_failure_no_longer_explains_anything(self):
        flights._note_upstream("opensky_states", "HTTP 429")
        stale = time.time() + flights.UPSTREAM_STALE_S + 1
        assert flights.upstream_failing("opensky_states", now=stale) is False

    def test_the_last_known_row_stands_in_while_the_feed_is_down(self, monkeypatch):
        row = ["a1b2c3", "ENY3656", None, None, None, -90.1, 39.9, None, False]
        flights._state_row_cache["a1b2c3"] = (time.time(), row)

        async def failing_get(*args, **kwargs):
            raise httpx.ConnectError("boom")

        client = types.SimpleNamespace(get=failing_get)
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights.fetch_state_by_icao24(client, "A1B2C3")) is row

    def test_a_stale_cached_row_is_not_passed_off_as_current(self, monkeypatch):
        row = ["a1b2c3", "ENY3656"]
        flights._state_row_cache["a1b2c3"] = (time.time() - flights.STATE_ROW_TTL - 1, row)

        async def failing_get(*args, **kwargs):
            raise httpx.ConnectError("boom")

        client = types.SimpleNamespace(get=failing_get)
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights.fetch_state_by_icao24(client, "a1b2c3")) is None

    def test_a_reachable_feed_reporting_nothing_drops_the_cached_row(self, monkeypatch):
        """The aircraft really has stopped transmitting; keeping it would invent a position."""
        flights._state_row_cache["a1b2c3"] = (time.time(), ["a1b2c3", "ENY3656"])

        async def empty_get(*args, **kwargs):
            return _FakeResponse({"states": []})

        client = types.SimpleNamespace(get=empty_get)
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights.fetch_state_by_icao24(client, "a1b2c3")) is None
        assert "a1b2c3" not in flights._state_row_cache


class TestAllStatesCache:
    """The scan that finds a partner-operated flight is what was burning the rate limit."""

    def setup_method(self):
        flights._all_states_cache.clear()
        flights._last_upstream_error.clear()

    teardown_method = setup_method

    def test_one_snapshot_serves_every_pin_on_the_board(self, monkeypatch):
        calls = []

        async def counted_get(*args, **kwargs):
            calls.append(1)
            return _FakeResponse({"states": [["a1b2c3", "ENY3656"]]})

        client = types.SimpleNamespace(get=counted_get)
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)

        for _ in range(6):
            assert _run(flights._all_states(client)) == [["a1b2c3", "ENY3656"]]
        assert len(calls) == 1

    def test_an_expired_snapshot_is_fetched_again(self, monkeypatch):
        flights._all_states_cache[:] = [(time.time() - flights.STATES_CACHE_TTL - 1, [["old"]])]

        async def fresh_get(*args, **kwargs):
            return _FakeResponse({"states": [["new"]]})

        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights._all_states(types.SimpleNamespace(get=fresh_get))) == [["new"]]

    def test_a_failed_scan_is_recorded_rather_than_cached(self, monkeypatch):
        async def failing_get(*args, **kwargs):
            raise httpx.ConnectError("HTTP 429")

        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights._all_states(types.SimpleNamespace(get=failing_get))) == []
        assert flights._all_states_cache == []
        assert flights.upstream_failing("opensky_states") is True


class TestWorldwideAirportFallback:
    """Coordinates for an airport outside the small home-region `AIRPORTS` table.

    The reported bug: a pinned flight's progress bar stayed at 0% for its entire duration whenever
    the destination was outside `AIRPORTS` (which only covers the deployment's home region) and
    the historical adsbdb/adsb.lol route guess for that callsign named a different city pair (as
    it routinely does -- airlines reuse flight numbers) and so was rejected. `_build_pin_context`
    needs both endpoints' coordinates to compute a fraction along the route at all; with the
    destination coordinate-less, that computation never had anything to divide by. This table is
    the fix: real coordinates for any airport at all, so a schedule feed's IATA code always
    resolves to *something* the progress and route maths can use.
    """

    @pytest.fixture(autouse=True)
    def worldwide_fixture(self, monkeypatch):
        # A small, deterministic stand-in for the real ~8700-airport file -- these tests assert
        # the fallback wiring, not the bundled data itself.
        monkeypatch.setattr(flights, "WORLDWIDE_AIRPORTS", {
            "KMAF": ["MAF", "Midland", "US", 31.9425, -102.202],
            "VOHS": [None, "Hyderabad", "IN", 17.2313, 78.4299],  # a real field with no IATA code
        })
        monkeypatch.setattr(flights, "WORLDWIDE_AIRPORTS_BY_IATA", {
            "MAF": ("KMAF", ["MAF", "Midland", "US", 31.9425, -102.202]),
        })

    def test_resolve_airport_falls_back_to_the_worldwide_table(self):
        assert flights.resolve_airport("KMAF") == {"code": "MAF", "city": "Midland", "lat": 31.9425, "lon": -102.202}

    def test_resolve_airport_still_prefers_the_local_table_when_both_know_it(self):
        # AUS is in the real local AIRPORTS table; the worldwide fixture above doesn't even have it,
        # so this also proves the local table is consulted first rather than skipped.
        result = flights.resolve_airport("KAUS")
        assert result["code"] == "AUS"

    def test_resolve_airport_without_an_iata_code_still_gets_coordinates(self):
        # The worldwide table's own code is None for VOHS; the ICAO-derived label fills in for it.
        assert flights.resolve_airport("VOHS") == {"code": "VOHS", "city": "Hyderabad", "lat": 17.2313, "lon": 78.4299}

    def test_an_airport_in_neither_table_still_returns_a_bare_label(self):
        assert flights.resolve_airport("KZZZ") == {"code": "ZZZ", "city": None, "lat": None, "lon": None}

    def test_schedule_airport_falls_back_to_the_worldwide_table_by_iata(self):
        assert flights._schedule_airport("MAF", None) == {"code": "MAF", "city": "Midland", "lat": 31.9425, "lon": -102.202}

    def test_schedule_airport_keeps_the_schedules_own_city_name_when_it_has_one(self):
        # The schedule feed's own city name is worth keeping even when the coordinate has to come
        # from elsewhere -- it is what the person pinning the flight actually typed the code for.
        result = flights._schedule_airport("MAF", "Midland-Odessa")
        assert result["city"] == "Midland-Odessa"
        assert result["lat"] == 31.9425

    def test_schedule_airport_with_an_unresolvable_code_is_still_a_labelled_stub(self):
        assert flights._schedule_airport("ZZZ", "Nowhere") == {"code": "ZZZ", "city": "Nowhere", "lat": None, "lon": None}


class TestThinPoints:
    """The flown-path polyline is capped for the wire; the shape has to survive the cut."""

    def test_short_lists_pass_through_untouched(self):
        points = [(1.0, 2.0), (3.0, 4.0)]
        assert flights._thin_points(points, 150) == [{"lat": 1.0, "lon": 2.0}, {"lat": 3.0, "lon": 4.0}]

    def test_a_long_list_is_capped_at_the_limit(self):
        points = [(float(i), float(i)) for i in range(500)]
        result = flights._thin_points(points, 100)
        assert len(result) <= 100

    def test_the_first_and_last_points_survive_the_cut(self):
        points = [(float(i), float(i)) for i in range(500)]
        result = flights._thin_points(points, 50)
        assert result[0] == {"lat": 0.0, "lon": 0.0}
        assert result[-1] == {"lat": 499.0, "lon": 499.0}

    def test_an_empty_list_stays_empty(self):
        assert flights._thin_points([], 150) == []


class TestOpenskyTrackPoints:
    def test_airborne_points_are_kept_in_order(self, monkeypatch):
        path = [[1000, 30.0, -97.0, 35000, 90, False], [1010, 30.1, -97.1, 35000, 90, False]]
        client = _fake_get_client({"path": path})
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights._opensky_track_points(client, "a5d965")) == [(30.0, -97.0), (30.1, -97.1)]

    def test_grounded_taxi_points_are_dropped(self, monkeypatch):
        path = [[1000, 30.0, -97.0, 0, 0, True], [1010, 30.1, -97.1, 35000, 90, False]]
        client = _fake_get_client({"path": path})
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights._opensky_track_points(client, "a5d965")) == [(30.1, -97.1)]

    def test_a_missing_path_is_reported_as_no_points(self, monkeypatch):
        client = _fake_get_client({})
        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        assert _run(flights._opensky_track_points(client, "a5d965")) == []

    def test_a_failure_is_reported_and_yields_nothing(self, monkeypatch):
        async def failing_get(*args, **kwargs):
            raise httpx.ConnectError("boom")

        monkeypatch.setattr(flights, "_opensky_headers", _no_headers)
        flights._last_upstream_error.pop("opensky_tracks", None)
        assert _run(flights._opensky_track_points(types.SimpleNamespace(get=failing_get), "a5d965")) == []
        assert flights.upstream_failing("opensky_tracks") is True


class TestFlownPath:
    @pytest.fixture(autouse=True)
    def clear_cache(self):
        flights._flown_path_cache.clear()
        yield
        flights._flown_path_cache.clear()

    def test_prefers_opensky_and_never_touches_the_fallback_feed_when_it_answers(self, monkeypatch):
        monkeypatch.setattr(flights, "_opensky_track_points", _stub(lambda client, icao24: [(30.0, -97.0)]))
        fallback_calls = []

        async def fallback(*args, **kwargs):
            fallback_calls.append(1)
            return []

        monkeypatch.setattr(flights.flight_sources, "trace_points", fallback)
        result = _run(flights.flown_path(object(), "a5d965", "SWA1626"))
        assert result == [{"lat": 30.0, "lon": -97.0}]
        assert fallback_calls == []

    def test_falls_back_to_the_keyless_trace_when_opensky_has_nothing(self, monkeypatch):
        monkeypatch.setattr(flights, "_opensky_track_points", _stub(lambda client, icao24: []))

        async def fallback(client, icao24, callsign, on_error):
            assert (icao24, callsign) == ("a5d965", "SWA1626")
            return [(31.0, -100.9)]

        monkeypatch.setattr(flights.flight_sources, "trace_points", fallback)
        result = _run(flights.flown_path(object(), "a5d965", "SWA1626"))
        assert result == [{"lat": 31.0, "lon": -100.9}]

    def test_a_cached_result_is_served_without_calling_either_source_again(self, monkeypatch):
        calls = []

        async def counted(*args, **kwargs):
            calls.append(1)
            return [(30.0, -97.0)]

        monkeypatch.setattr(flights, "_opensky_track_points", counted)
        _run(flights.flown_path(object(), "a5d965", "SWA1626"))
        _run(flights.flown_path(object(), "a5d965", "SWA1626"))
        assert len(calls) == 1

    def test_no_known_aircraft_is_an_empty_path_with_no_network_calls(self, monkeypatch):
        called = []
        monkeypatch.setattr(flights, "_opensky_track_points", _stub(lambda client, icao24: called.append(1)))
        assert _run(flights.flown_path(object(), None, "SWA1626")) == []
        assert called == []


def _stub(fn):
    async def call(client, icao24):
        return fn(client, icao24)
    return call


def _fake_get_client(payload):
    async def get(*args, **kwargs):
        return _FakeResponse(payload)

    return types.SimpleNamespace(get=get)


async def _no_headers(_client):
    return {}


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _run(coro):
    import asyncio

    return asyncio.run(coro)


async def _stub_board():
    """The board build makes live upstream calls; the pin bookkeeping is what these assert."""
    return {"flights": []}
