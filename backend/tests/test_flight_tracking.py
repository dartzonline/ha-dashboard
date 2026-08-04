"""Multi-flight pin bookkeeping.

These cover the rules that decide when a pinned flight stays on the board, because the bug that
prompted them was a flight quietly disappearing mid-air: a pin must survive a gap in OpenSky
coverage and must not be retired by a schedule feed still reporting the previous leg as landed.
"""

import time

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


def _run(coro):
    import asyncio

    return asyncio.run(coro)


async def _stub_board():
    """The board build makes live upstream calls; the pin bookkeeping is what these assert."""
    return {"flights": []}
