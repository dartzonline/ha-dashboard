"""Internet outage detection.

These cover the cases that produced wrong answers against real Home Assistant
data rather than invented ones: a 7-day request answered with 24h of retained
history read as a six-day ongoing outage ("uptime 14%" on a healthy line), and
the same 30-second drop being counted twice because two sensors witnessed it a
moment apart.
"""

from datetime import datetime, timezone

from app import connectivity


def row(offset_s: float, state: str, base: float = 1_700_000_000.0) -> dict:
    stamp = datetime.fromtimestamp(base + offset_s, timezone.utc)
    return {"last_changed": stamp.isoformat().replace("+00:00", "Z"), "state": state}


BASE = 1_700_000_000.0


class TestBinarySensorOutages:
    def test_an_off_span_becomes_one_outage(self):
        rows = [row(0, "on"), row(100, "off"), row(130, "on")]
        spans = connectivity.outages_from_binary(rows, BASE + 200, "wan")
        assert len(spans) == 1
        assert spans[0]["start"] == BASE + 100
        assert spans[0]["end"] == BASE + 130
        assert spans[0]["ongoing"] is False

    def test_unavailable_counts_as_down(self):
        """The integration losing contact is an outage too, not a missing value."""
        rows = [row(0, "on"), row(50, "unavailable"), row(90, "on")]
        assert len(connectivity.outages_from_binary(rows, BASE + 100, "wan")) == 1

    def test_a_drop_still_open_is_reported_as_ongoing(self):
        rows = [row(0, "on"), row(60, "off")]
        spans = connectivity.outages_from_binary(rows, BASE + 300, "wan")
        assert spans[0]["ongoing"] is True
        assert spans[0]["end"] == BASE + 300

    def test_a_healthy_sensor_reports_nothing(self):
        rows = [row(0, "on"), row(100, "on"), row(200, "on")]
        assert connectivity.outages_from_binary(rows, BASE + 300, "wan") == []


class TestGapOutages:
    def _steady(self, count: int, step: float = 30.0) -> list[dict]:
        return [row(index * step, str(100 + index)) for index in range(count)]

    def test_a_long_silence_between_readings_is_an_outage(self):
        rows = self._steady(10) + [row(9 * 30 + 600, "555")]
        spans = connectivity.outages_from_gaps(rows, BASE + 9 * 30 + 630, "throughput")
        assert len(spans) == 1
        assert spans[0]["end"] - spans[0]["start"] == 600

    def test_one_skipped_poll_is_not_an_outage(self):
        """A 30s cadence routinely slips to 60s; calling that an outage would
        report a drop several times an hour on a healthy connection."""
        rows = self._steady(6) + [row(6 * 30 + 60, "999")]
        assert connectivity.outages_from_gaps(rows, BASE + 6 * 30 + 90, "throughput") == []

    def test_threshold_scales_with_a_slower_sensor(self):
        # A sensor that only reports every 5 minutes must not have its normal
        # cadence read as continuous outages.
        rows = [row(index * 300, str(index)) for index in range(8)]
        assert connectivity.outages_from_gaps(rows, BASE + 7 * 300 + 60, "throughput") == []

    def test_the_end_of_retained_history_is_not_an_ongoing_outage(self):
        """The bug this was written for: Home Assistant answers a 7-day history
        request with only the ~24h it kept, and that trailing absence was being
        reported as a six-day outage in progress -- 14% uptime on a line that
        never dropped."""
        rows = self._steady(20)
        six_days_later = BASE + 19 * 30 + 6 * 86400
        spans = connectivity.outages_from_gaps(rows, six_days_later, "throughput")
        assert spans == []

    def test_recent_silence_is_still_treated_as_a_live_outage(self):
        rows = self._steady(20)
        spans = connectivity.outages_from_gaps(rows, BASE + 19 * 30 + 300, "throughput")
        assert len(spans) == 1
        assert spans[0]["ongoing"] is True

    def test_too_little_data_reports_nothing(self):
        assert connectivity.outages_from_gaps([row(0, "1")], BASE + 10_000, "throughput") == []


class TestIpChanges:
    def test_a_changed_address_is_recorded(self):
        rows = [row(0, "1.2.3.4"), row(100, "5.6.7.8")]
        changes = connectivity.ip_changes(rows)
        assert len(changes) == 1
        assert changes[0]["from"] == "1.2.3.4"
        assert changes[0]["to"] == "5.6.7.8"

    def test_unavailable_is_not_treated_as_an_address(self):
        """Otherwise one reconnect reads as two changes (real -> unavailable ->
        real) and doubles the apparent count."""
        rows = [row(0, "1.2.3.4"), row(50, "unavailable"), row(100, "1.2.3.4")]
        assert connectivity.ip_changes(rows) == []

    def test_a_stable_address_reports_nothing(self):
        rows = [row(0, "1.2.3.4"), row(100, "1.2.3.4")]
        assert connectivity.ip_changes(rows) == []


class TestMergeSpans:
    def test_the_same_outage_seen_by_two_sensors_is_counted_once(self):
        """A polled sensor notices late and an event-driven one immediately, so
        without merging one drop would be reported as several."""
        spans = [
            {"start": BASE + 100, "end": BASE + 130, "source": "wan", "ongoing": False},
            {"start": BASE + 105, "end": BASE + 140, "source": "throughput", "ongoing": False},
        ]
        merged = connectivity.merge_spans(spans)
        assert len(merged) == 1
        assert merged[0]["sources"] == ["throughput", "wan"]
        assert merged[0]["end"] == BASE + 140

    def test_distant_outages_stay_separate(self):
        spans = [
            {"start": BASE, "end": BASE + 30, "source": "wan", "ongoing": False},
            {"start": BASE + 5000, "end": BASE + 5030, "source": "wan", "ongoing": False},
        ]
        assert len(connectivity.merge_spans(spans)) == 2

    def test_an_ongoing_span_keeps_that_flag_through_a_merge(self):
        spans = [
            {"start": BASE + 100, "end": BASE + 130, "source": "wan", "ongoing": False},
            {"start": BASE + 110, "end": BASE + 200, "source": "throughput", "ongoing": True},
        ]
        assert connectivity.merge_spans(spans)[0]["ongoing"] is True


class TestSummarize:
    def test_uptime_is_measured_over_observed_history_not_the_request(self):
        """Dividing a 30s outage by a requested 7-day window that mostly has no
        data is what produced the nonsense 14% reading."""
        spans = [{"start": BASE + 100, "end": BASE + 130, "ongoing": False, "sources": ["wan"]}]
        requested_start = BASE - 6 * 86400
        out = connectivity.summarize(spans, requested_start, BASE + 86400, observed_start=BASE)
        assert out["uptimePercent"] > 99.9
        assert out["observedHours"] == 24.0

    def test_a_short_drop_is_reported_as_a_blip(self):
        spans = [{"start": BASE, "end": BASE + 0.4, "ongoing": False, "sources": ["wan"]}]
        out = connectivity.summarize(spans, BASE - 3600, BASE + 3600, observed_start=BASE - 3600)
        assert out["blipCount"] == 1
        assert out["outageCount"] == 0

    def test_a_clean_window_reports_full_uptime(self):
        out = connectivity.summarize([], BASE, BASE + 86400, observed_start=BASE)
        assert out["uptimePercent"] == 100.0
        assert out["outageCount"] == 0
        assert out["ongoing"] is False

    def test_uptime_never_goes_negative(self):
        """An outage recorded as longer than the observed window (clock skew,
        overlapping sources) must not produce a negative percentage."""
        spans = [{"start": BASE - 10_000, "end": BASE + 10_000, "ongoing": True, "sources": ["wan"]}]
        out = connectivity.summarize(spans, BASE, BASE + 100, observed_start=BASE)
        assert 0.0 <= out["uptimePercent"] <= 100.0


class TestPollInterval:
    def test_the_median_cadence_is_reported(self):
        rows = [row(index * 30, str(index)) for index in range(10)]
        assert connectivity.poll_interval(rows) == 30.0

    def test_too_little_data_reports_none(self):
        assert connectivity.poll_interval([row(0, "1")]) is None


class TestDataCoverage:
    def test_coverage_starts_where_history_does(self):
        rows = [row(0, "1"), row(3600, "2")]
        start, end = connectivity.data_coverage(rows, BASE - 86400, BASE + 7200)
        assert start == BASE
        assert end == BASE + 3600

    def test_no_history_falls_back_to_the_requested_window(self):
        start, end = connectivity.data_coverage([], BASE, BASE + 100)
        assert (start, end) == (BASE, BASE + 100)
