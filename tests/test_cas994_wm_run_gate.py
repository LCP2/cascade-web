"""CAS-994 — a per-run Watchmode credit ceiling (WM_RUN_MAX_CREDITS, default 0) gating every
credit-costing Watchmode call path, paced against Watchmode's own live /status figures rather
than the local state/api_budget.json ledger (which had drifted from the real account — see the
ticket's own Why).

wm_run_allowance() is the single gate: 0 (the default) makes no Watchmode call at all, not even
the free GET /status or ID map — AC1. A non-zero ceiling paces against GET /status's live
{quota, quotaUsed} with the same CAS-987 formula, capped at the ceiling — AC2. A failed /status
spends nothing rather than raising — AC3. enrich_watchmode_fields_nightly and
run_scoreability_probe each independently refuse to fetch the ID map at all once handed a 0
budget, so a paused run makes no Watchmode network call from either pass — AC1/AC4.
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp


class WmRunAllowance(unittest.TestCase):
    def test_a_zero_ceiling_makes_no_status_call_and_prints_the_paused_line(self):
        with mock.patch.object(pp, "_fetch_watchmode_status") as status_fn, \
             mock.patch("builtins.print") as mock_print:
            pot = pp.wm_run_allowance(datetime.date(2026, 9, 16), run_max_credits=0)
        self.assertEqual(pot, 0)
        status_fn.assert_not_called()
        printed = " ".join(str(c.args[0]) for c in mock_print.call_args_list)
        self.assertIn("[watchmode] paused: WM_RUN_MAX_CREDITS=0", printed)

    def test_an_unset_default_ceiling_is_also_zero_and_paused(self):
        with mock.patch.object(pp, "WM_RUN_MAX_CREDITS", 0), \
             mock.patch.object(pp, "_fetch_watchmode_status") as status_fn:
            pot = pp.wm_run_allowance(datetime.date(2026, 9, 16))
        self.assertEqual(pot, 0)
        status_fn.assert_not_called()

    def test_a_near_exhausted_live_quota_caps_the_allowance_at_what_remains(self):
        # quota=10000, quotaUsed=9990 -> only 10 credits actually left on the account; whatever
        # the cycle-pacing formula does with that, it can never exceed the 10 truly remaining.
        with mock.patch.object(pp, "_fetch_watchmode_status",
                               return_value={"quota": 10000, "quotaUsed": 9990}):
            pot = pp.wm_run_allowance(datetime.date(2026, 9, 16), run_max_credits=50)
        self.assertLessEqual(pot, 10)

    def test_the_ceiling_caps_a_generous_live_allowance(self):
        with mock.patch.object(pp, "_fetch_watchmode_status",
                               return_value={"quota": 10000, "quotaUsed": 1000}):
            pot = pp.wm_run_allowance(datetime.date(2026, 9, 16), run_max_credits=50)
        self.assertLessEqual(pot, 50)

    def test_a_failed_status_call_spends_nothing_and_does_not_raise(self):
        with mock.patch.object(pp, "_fetch_watchmode_status", side_effect=RuntimeError("boom")):
            pot = pp.wm_run_allowance(datetime.date(2026, 9, 16), run_max_credits=50)
        self.assertEqual(pot, 0)


class EnrichWatchmodeFieldsNightlyBudgetGate(unittest.TestCase):
    def test_a_zero_budget_makes_no_id_map_call(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap") as idmap_fn:
            outcomes = pp.enrich_watchmode_fields_nightly(
                [{"tmdb_id": 1, "imdb_id": "tt1", "status": []}],
                budget={"remaining": 0, "skipped": 0})
        idmap_fn.assert_not_called()
        self.assertEqual(outcomes, {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0})

    def test_a_nonzero_budget_still_fetches_the_id_map(self):
        with mock.patch.object(pp, "WATCHMODE_KEY", "trial-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={}) as idmap_fn:
            pp.enrich_watchmode_fields_nightly([], budget={"remaining": 10, "skipped": 0})
        idmap_fn.assert_called_once()


class RunScoreabilityProbeBudgetGate(unittest.TestCase):
    def test_a_zero_budget_makes_no_id_map_call(self):
        with mock.patch.object(pp, "WATCHMODE_KEY", "trial-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap") as idmap_fn:
            outcomes = pp.run_scoreability_probe({}, datetime.date(2026, 9, 16), 0, set())
        idmap_fn.assert_not_called()
        self.assertEqual(outcomes["spent"], 0)

    def test_a_nonzero_budget_still_fetches_the_id_map(self):
        with mock.patch.object(pp, "WATCHMODE_KEY", "trial-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={}) as idmap_fn:
            pp.run_scoreability_probe({}, datetime.date(2026, 9, 16), 10, set())
        idmap_fn.assert_called_once()


class BuildLiveCatalogueWatchmodeSpineGate(unittest.TestCase):
    """The CASCADE_SPINE=watchmode ingest path (dormant by default) costs credits too, so it's
    gated on the same wm_budget_cap the on-demand poll already respects."""

    def test_a_paused_run_makes_no_watchmode_spine_ingest_call(self):
        with mock.patch.object(pp, "CASCADE_SPINE", "watchmode"), \
             mock.patch.object(pp, "ingest_watchmode") as ingest_fn, \
             mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0), \
             mock.patch.object(pp, "CINEMA_RELEASE_BACKFILL_BUDGET", 0):
            pp.build_live_catalogue(datetime.date(2026, 9, 16), [], {}, ondemand_ids=[],
                                    wm_budget_cap=0)
        ingest_fn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
