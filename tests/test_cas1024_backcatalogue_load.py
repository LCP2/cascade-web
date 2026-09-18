"""CAS-1024 — the one-shot manual back-catalogue probe (watchmode-backfill.yml's
target=backcatalogue mode). Unlike CAS-986's nightly probe_candidates(), this is the dispatcher's
own explicit spend decision: NOT capped by wm_run_allowance/WM_RUN_MAX_CREDITS/the CAS-987 cycle
pace — see run_backcatalogue_probe's docstring. Covers the four behaviours the ticket names: it
respects max_credits, stops at the 300 floor, ignores WM_RUN_MAX_CREDITS=0, and does not re-probe
titles already probed.
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp

_TODAY = datetime.date(2026, 9, 17)
_SCORED_DETAIL = {"user_rating": 8.0, "critic_score": 70, "popularity_percentile": 50}


def _candidate(tmdb_id, popularity=1.0, outcome="unprobed"):
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": 2020, "status": [],
            "popularity": popularity, "first_seen": "2026-01-01", "last_probed": None,
            "probe_count": 0, "outcome": outcome}


class RunBackcatalogueProbeTestCase(unittest.TestCase):
    def test_respects_max_credits(self):
        candidates = {str(i): _candidate(i, popularity=i) for i in range(1, 6)}
        wm_idmap = {i: f"wm{i}" for i in range(1, 6)}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=_SCORED_DETAIL):
            outcomes = pp.run_backcatalogue_probe(
                candidates, _TODAY, max_credits=2, wm_idmap=wm_idmap,
                backcat_ids=set(range(1, 6)), fetch_remaining_credits=lambda: 10000)

        self.assertEqual(outcomes["spent"], 2)
        probed_now = sum(1 for c in candidates.values() if c["last_probed"] is not None)
        self.assertEqual(probed_now, 2)
        # most popular first: ids 5 and 4 spend the 2-credit budget; 1-3 stay untouched.
        self.assertEqual(candidates["5"]["outcome"], "scored")
        self.assertEqual(candidates["4"]["outcome"], "scored")
        self.assertEqual(candidates["1"]["outcome"], "unprobed")

    def test_stops_at_the_300_floor(self):
        candidates = {str(i): _candidate(i, popularity=i) for i in range(1, 4)}
        wm_idmap = {i: f"wm{i}" for i in range(1, 4)}
        remaining_sequence = iter([500, 250])  # second check reports below the floor
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=_SCORED_DETAIL):
            outcomes = pp.run_backcatalogue_probe(
                candidates, _TODAY, max_credits=100, wm_idmap=wm_idmap,
                backcat_ids=set(range(1, 4)),
                fetch_remaining_credits=lambda: next(remaining_sequence), upkeep_floor=300)

        self.assertTrue(outcomes["stopped_on_floor"])
        self.assertEqual(outcomes["spent"], 1)
        self.assertEqual(candidates["3"]["outcome"], "scored")   # most popular, probed before the stop
        self.assertEqual(candidates["2"]["outcome"], "unprobed")  # stopped before this one

    def test_ignores_wm_run_max_credits_zero(self):
        candidates = {"1": _candidate(1)}
        wm_idmap = {1: "wm1"}
        with mock.patch.object(pp, "WM_RUN_MAX_CREDITS", 0), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=_SCORED_DETAIL):
            outcomes = pp.run_backcatalogue_probe(
                candidates, _TODAY, max_credits=5, wm_idmap=wm_idmap, backcat_ids={1},
                fetch_remaining_credits=lambda: 10000)

        self.assertEqual(outcomes["spent"], 1)
        self.assertEqual(candidates["1"]["outcome"], "scored")

    def test_does_not_reprobe_already_probed_titles(self):
        already_scored = _candidate(1, outcome="scored")
        already_scored["last_probed"] = "2026-09-01"
        already_scored["probe_count"] = 1
        already_no_score = _candidate(2, outcome="no_score")
        candidates = {"1": already_scored, "2": already_no_score, "3": _candidate(3)}
        wm_idmap = {1: "wm1", 2: "wm2", 3: "wm3"}

        with mock.patch.object(pp, "_fetch_watchmode_title_details",
                               return_value=_SCORED_DETAIL) as detail_fn:
            outcomes = pp.run_backcatalogue_probe(
                candidates, _TODAY, max_credits=10, wm_idmap=wm_idmap, backcat_ids={1, 2, 3},
                fetch_remaining_credits=lambda: 10000)

        self.assertEqual(outcomes["spent"], 1)
        self.assertEqual(detail_fn.call_count, 1)
        self.assertEqual(candidates["1"], already_scored)      # untouched
        self.assertEqual(candidates["2"], already_no_score)    # untouched, no recovery window here
        self.assertEqual(candidates["3"]["outcome"], "scored")


if __name__ == "__main__":
    unittest.main()
