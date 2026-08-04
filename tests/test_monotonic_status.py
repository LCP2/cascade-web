"""CAS-355 — availability status must move MONOTONICALLY (toward more availability), and the
alert path must never fire for a backward move.

Per the CAS-334 appraisal (docs/appraisals/cas334-data-accuracy.md): 39% of recorded status
transitions were backward, and 80 real downgrade alerts were driven by a title's status flapping
across a transient AU-provider gap (JustWatch briefly drops a title's rows, then picks it back up
the next day) rather than any real change in the film's availability.

Covers the two places a status transition gets decided, which both read/write the SAME status
field and must agree on what counts as "forward":
  - poc_pipeline.apply_monotonic_status / diff_and_alert (the writer + its own alert log)
  - monitor.compute_transitions (the real alert path — CAS-84/CAS-85/CAS-86)
"""
import datetime
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp
from monitor.transitions import compute_transitions


def _title(tmdb_id=1, **kw):
    m = {"tmdb_id": tmdb_id, "imdb_id": f"tt{tmdb_id:07d}", "title": f"Film {tmdb_id}",
         "cinema_date": "2025-01-01", "popularity": 10.0,
         "status": ["included_streaming"], "availability_confidence": "confirmed",
         "offers": []}
    m.update(kw)
    return m


class TierRankIsTheSingleCanonicalOrder(unittest.TestCase):
    def test_order_runs_least_to_most_available(self):
        self.assertEqual(pp.AVAILABILITY_TIERS,
                          ["upcoming", "in_cinema", "pvod", "rental", "included_streaming"])

    def test_rank_picks_the_highest_tier_present(self):
        self.assertEqual(pp.tier_rank(["upcoming"]), 0)
        self.assertEqual(pp.tier_rank(["rental", "pvod"]), 3)
        self.assertEqual(pp.tier_rank(["included_streaming"]), 4)

    def test_rank_of_nothing_recognised_is_minus_one(self):
        self.assertEqual(pp.tier_rank([]), -1)
        self.assertEqual(pp.tier_rank(["past_opening"]), -1)   # a moment, not a tier a film holds


class ApplyMonotonicStatus(unittest.TestCase):
    """Direct unit tests of the guard poc_pipeline writes m['status'] through."""

    def test_first_sighting_commits_whatever_it_is(self):
        m = {}
        pp.apply_monotonic_status(m, ["rental"], "confirmed", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["rental"])
        self.assertEqual(m["availability_confidence"], "confirmed")

    def test_a_forward_move_commits_immediately(self):
        m = {"status": ["rental"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["included_streaming"], "confirmed", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertNotIn("pending_downgrade", m)

    def test_a_single_backward_read_is_held_back(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        self.assertEqual(m["status"], ["included_streaming"])              # unchanged
        self.assertEqual(m["availability_confidence"], "confirmed")        # not clobbered either
        self.assertEqual(m["pending_downgrade"], {"to": ["rental"], "runs": 1, "since": "2026-08-01"})

    def test_the_same_backward_read_repeated_confirms_after_N_runs(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 2))
        self.assertEqual(m["status"], ["rental"])                          # genuine regression lands
        self.assertEqual(m["availability_confidence"], "estimated")
        self.assertNotIn("pending_downgrade", m)

    def test_a_recovering_read_between_two_gaps_never_confirms(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))        # gap
        pp.apply_monotonic_status(m, ["included_streaming"], "confirmed", datetime.date(2026, 8, 2))  # recovers
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 3))        # gap again
        self.assertEqual(m["status"], ["included_streaming"])              # still held — count restarted
        self.assertEqual(m["pending_downgrade"]["runs"], 1)

    def test_a_different_backward_candidate_restarts_the_count(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 1))
        pp.apply_monotonic_status(m, ["pvod"], "estimated", datetime.date(2026, 8, 2))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertEqual(m["pending_downgrade"], {"to": ["pvod"], "runs": 1, "since": "2026-08-02"})


class ComputeTransitionsOnlyFiresForward(unittest.TestCase):
    """Belt-and-braces at the monitor layer — the ticket names both poc_pipeline.py and the
    monitor module as needing the fix, since a real alert is sent from here (CAS-85/CAS-86),
    not from poc_pipeline's own state/alerts.json log."""

    def test_a_lower_tier_landing_is_never_alerted(self):
        # The exact CAS-334 finding: a title held included_streaming, a provider-feed gap made
        # the next read rental-only, and the old code fired hits_rent as if rental were a gain.
        prev = [{"tmdb_id": 1, "title": "Tilly", "status": ["included_streaming"], "offers": []}]
        today = [{"tmdb_id": 1, "title": "Tilly", "status": ["rental"],
                  "offers": [{"service": "Prime Video", "type": "rent", "price": 6.99}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(transitions, [])

    def test_a_genuine_forward_move_still_fires_exactly_once(self):
        prev = [{"tmdb_id": 2, "title": "Real Riser", "status": ["rental"], "offers": []}]
        today = [{"tmdb_id": 2, "title": "Real Riser", "status": ["included_streaming"],
                  "offers": [{"service": "Stan", "type": "sub", "price": None}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(len(transitions), 1)
        self.assertEqual(transitions[0].moment, "hits_stream")

    def test_a_status_already_held_is_never_refired_by_a_neighbouring_loss(self):
        # Held BOTH rental and streaming, loses rental (streaming untouched) -> nothing to alert:
        # streaming was already there, and rental disappearing is a loss, not a gain.
        prev = [{"tmdb_id": 3, "title": "Dual Window", "status": ["rental", "included_streaming"],
                 "offers": []}]
        today = [{"tmdb_id": 3, "title": "Dual Window", "status": ["included_streaming"],
                  "offers": [{"service": "Stan", "type": "sub", "price": None}]}]
        transitions = compute_transitions(prev, today, datetime.date(2026, 8, 1))
        self.assertEqual(transitions, [])


class TransientProviderDropEndToEnd(unittest.TestCase):
    """The CAS-355 acceptance-criterion #4 sequence, exercised across the real write path
    (poc_pipeline.build_live_catalogue) and the real alert log (poc_pipeline.diff_and_alert)
    together: a transient provider drop must not regress status or fire an alert; a genuine
    forward move must fire exactly one."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _poll_day(self, day, base, has_rows):
        with mock.patch.object(pp, "tmdb_providers", lambda tid: {"jw_link": None}), \
             mock.patch.object(pp, "has_provider_rows", lambda p: has_rows), \
             mock.patch.object(pp, "provider_offers",
                               lambda p: [{"service": "Netflix", "type": "sub",
                                           "price": None, "format": None}]), \
             mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]), \
             mock.patch.object(pp.ps, "estimate_status", lambda m, t, offsets: ("rental", "estimated")):
            catalogue, _ = pp.build_live_catalogue(day, base, {}, ondemand_ids=[])
        return catalogue

    def test_a_transient_gap_does_not_regress_status_or_fire_an_alert(self):
        day0 = [_title(1, status=["included_streaming"])]
        pp.diff_and_alert(day0)                                          # seeds "yesterday"

        day1 = self._poll_day(datetime.date(2026, 8, 1), day0, has_rows=False)   # the gap
        events = pp.diff_and_alert(day1)

        self.assertEqual(day1[0]["status"], ["included_streaming"])      # (a) held, not demoted
        self.assertEqual(events, [])                                     # (b) nothing to alert

    def test_a_genuine_forward_move_fires_exactly_one_alert(self):
        day0 = [_title(1, status=["rental"], offers=[])]
        pp.diff_and_alert(day0)

        day1 = self._poll_day(datetime.date(2026, 8, 1), day0, has_rows=True)    # a real gain
        events = pp.diff_and_alert(day1)

        self.assertEqual(day1[0]["status"], ["included_streaming"])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["new_window"], "included_streaming")


if __name__ == "__main__":
    unittest.main()
