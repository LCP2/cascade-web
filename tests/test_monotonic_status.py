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
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            # CAS-379: this fixture's titles predate cinema_release too; a no-op keeps that
            # back-fill path (orthogonal to what this class tests) from hitting the network.
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
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


class ZeroAuRowsNeverInventAPaidTier(unittest.TestCase):
    """CAS-412: when TMDB/JustWatch AU returns literally no provider row, there is no real offer
    to back a home window. The old code fell to estimate_status's age ladder here, which — once
    a title outlived the 14-day in-cinema estimate cap — guessed "pvod" out of thin air and then
    kept re-guessing the SAME "pvod" every subsequent run (the ladder never ages back down), so a
    title that lost its only offer got stranded above the cinema window forever. This exercises
    the real write path (poc_pipeline.build_live_catalogue), mocking only the network call."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        empty_prov = {"flatrate": [], "rent": [], "buy": [], "ads": [], "free": [], "jw_link": None}
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers", lambda tid: empty_prov),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_title_with_no_offers_and_a_past_cinema_date_settles_on_in_cinema(self):
        # The Odyssey (CAS-412): a real buy/rent offer once put it at pvod, that offer is gone,
        # AU now returns zero rows outright, and the title opened 21 days ago — past the old
        # ladder's 14-day in-cinema cap, which used to make it read "pvod" with zero offers.
        opened_21_days_ago = (datetime.date(2026, 8, 6) - datetime.timedelta(days=21)).isoformat()
        base = [_title(1, status=["pvod"], cinema_date=opened_21_days_ago, offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 6), base, {}, ondemand_ids=[])
        self.assertEqual(day1[0]["status"], ["pvod"])                # first zero-offer read: held (CAS-355)
        self.assertEqual(day1[0]["offers"], [])
        self.assertEqual(day1[0]["pending_downgrade"]["to"], ["in_cinema"])

        day2, _ = pp.build_live_catalogue(datetime.date(2026, 8, 7), day1, {}, ondemand_ids=[])
        self.assertEqual(day2[0]["status"], ["in_cinema"])           # same candidate again: confirmed
        self.assertNotIn("pending_downgrade", day2[0])


class AnEstimatedTierIsNotOwedTheTransientGapHold(unittest.TestCase):
    """CAS-418: apply_monotonic_status's 2-run hold exists to protect a CONFIRMED tier (a real
    offer) from a one-day AU-feed gap (CAS-355, exercised above). A tier stamped "estimated" was
    never backed by a real offer, so — unlike the CAS-412 case above, whose base title carries
    the default "confirmed" confidence — it must not wait for DOWNGRADE_CONFIRM_RUNS either:
    908 titles on live were frozen exactly this way (CAS-418), some indefinitely, because a
    failed poll never advances the counter."""

    def test_a_backward_move_off_an_estimated_tier_commits_on_the_first_read(self):
        m = {"status": ["pvod"], "availability_confidence": "estimated"}
        pp.apply_monotonic_status(m, ["in_cinema"], "estimated", datetime.date(2026, 8, 7))
        self.assertEqual(m["status"], ["in_cinema"])
        self.assertNotIn("pending_downgrade", m)

    def test_a_confirmed_tier_is_unaffected_and_still_held(self):
        m = {"status": ["included_streaming"], "availability_confidence": "confirmed"}
        pp.apply_monotonic_status(m, ["rental"], "estimated", datetime.date(2026, 8, 7))
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertIn("pending_downgrade", m)


class DeriveFromProvidersFallbackRespectsTheCinemaRun(unittest.TestCase):
    """CAS-418 item 4: the offer-less fallback used to key off `opened` (cinema_date <= today),
    so a title that left cinemas years ago and lost its only offer read as "in_cinema" right
    now — turning a phantom-streaming title into an equally phantom in-cinema one. It must key
    off `still_running` (the same CINEMA_RUN_DAYS test the branch above it uses) instead."""

    def test_offer_less_and_still_within_its_run_reads_in_cinema(self):
        recent = (datetime.date(2026, 8, 7) - datetime.timedelta(days=10)).isoformat()
        windows = pp.derive_from_providers({"cinema_date": recent}, {}, datetime.date(2026, 8, 7))
        self.assertEqual(windows, ["in_cinema"])

    def test_offer_less_and_long_past_its_run_does_not_read_in_cinema(self):
        long_ago = (datetime.date(2026, 8, 7) - datetime.timedelta(days=400)).isoformat()
        windows = pp.derive_from_providers({"cinema_date": long_ago}, {}, datetime.date(2026, 8, 7))
        self.assertNotIn("in_cinema", windows)


class AFailedPollDoesNotFreezeAPhantomTierEither(unittest.TestCase):
    """CAS-418 item 3: a title already stuck on an offer-less "estimated" tier must heal even
    when TODAY's poll fails outright, not just when it succeeds with zero AU rows — otherwise an
    intermittently-failing provider call is exactly how a title got stranded indefinitely in the
    first place (the counter in test_pipeline_resilience's "failing provider call" case only
    protects a CONFIRMED tier, unaffected by this)."""

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
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers",
                               mock.Mock(side_effect=RuntimeError("network down"))),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_failed_poll_still_heals_an_offer_less_paid_tier(self):
        long_ago = (datetime.date(2026, 8, 7) - datetime.timedelta(days=400)).isoformat()
        base = [_title(1, status=["included_streaming"], cinema_date=long_ago,
                        availability_confidence="estimated", offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 7), base, {}, ondemand_ids=[])

        self.assertNotIn("included_streaming", day1[0]["status"])    # no offer ever backed it
        self.assertEqual(day1[0]["offers"], [])
        self.assertNotIn("pending_downgrade", day1[0])


class UpcomingLatchNeverTrapsAReleasedTitle(unittest.TestCase):
    """CAS-472: poll_scheduler.classify_tier used to also read `status == {"upcoming"}` alone as
    "none" (never polled again), with no check that the title had actually not opened yet. Once a
    title regressed all the way to upcoming for ANY reason — a real AU delisting past its cinema
    run, or this bug feeding itself — it got permanently stuck: poll_tier "none" is the only thing
    poc_pipeline.build_live_catalogue's `tier == "none"` branch checks before blindly re-stamping
    status=["upcoming"]/availability_confidence="confirmed" every run, with no provider poll to ever
    learn otherwise. 789 live titles were found latched exactly this way (e.g. "Perfect Marble",
    tmdb_id 1680044 — window_dates carried in_cinema/included_streaming stamps from real earlier
    runs, but status stayed frozen at upcoming indefinitely)."""

    def test_classify_tier_is_never_none_once_the_cinema_date_has_passed(self):
        long_ago = (datetime.date(2026, 8, 12) - datetime.timedelta(days=600)).isoformat()
        m = {"status": ["upcoming"], "cinema_date": long_ago}
        self.assertNotEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")

    def test_classify_tier_still_skips_a_title_that_has_not_opened_yet(self):
        not_yet = (datetime.date(2026, 8, 12) + datetime.timedelta(days=10)).isoformat()
        m = {"status": ["upcoming"], "cinema_date": not_yet}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")

    def test_classify_tier_still_skips_a_title_with_no_cinema_date_known_at_all(self):
        m = {"status": ["upcoming"], "cinema_date": None}
        self.assertEqual(pp.ps.classify_tier(m, datetime.date(2026, 8, 12)), "none")


class ALatchedUpcomingTitleSelfCorrectsOnTheNextRun(unittest.TestCase):
    """The end-to-end version of the fix above, exercised through the real write path
    (poc_pipeline.build_live_catalogue): a title shaped exactly like the live "Perfect Marble"
    record must get a real provider poll instead of being silently re-stamped upcoming again."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        state_dir = self._tmp.name
        streaming_prov = {"flatrate": [{"service": "Netflix"}], "rent": [], "buy": [],
                           "ads": [], "free": [], "jw_link": None}
        patches = [
            mock.patch.object(pp, "STATE_DIR", state_dir),
            mock.patch.object(pp, "SNAPSHOT_FILE", os.path.join(state_dir, "last_snapshot.json")),
            mock.patch.object(pp, "ALERTS_FILE", os.path.join(state_dir, "alerts.json")),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "tmdb_providers", lambda tid: streaming_prov),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_released_title_latched_at_upcoming_gets_polled_and_advances(self):
        long_ago = (datetime.date(2026, 8, 12) - datetime.timedelta(days=600)).isoformat()
        base = [_title(1, status=["upcoming"], cinema_date=long_ago,
                        availability_confidence="confirmed", offers=[])]

        day1, _ = pp.build_live_catalogue(datetime.date(2026, 8, 12), base, {}, ondemand_ids=[])

        self.assertEqual(day1[0]["poll_tier"], "slow")                # no longer latched at "none"
        self.assertEqual(day1[0]["status"], ["included_streaming"])   # the real offer, found and committed
        self.assertTrue(day1[0]["offers"])


if __name__ == "__main__":
    unittest.main()
