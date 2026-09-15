"""CAS-987 — Watchmode spend paced against the real monthly quota, not a fixed daily number.

Replaces the flat WM_NIGHTLY_MAX_CREDITS/ONDEMAND_WM_CAP/SCOREABILITY_PROBE_BUDGET pots with one
billing-cycle-aware allocator: state/api_budget.json now tracks {cycle_start, cycle_end, quota,
spent, updated_at, days}, and today's allowance is derived from what's left in the cycle rather
than hard-coded.

A note on AC1's own worked example: the ticket states quota=10000, reserve=10%, spent=1380,
27 days left computes to an allowance of 281. Working the ticket's own literal pseudocode
(`spendable = quota * (1 - reserve_pct/100) - spent; today = floor(spendable / days)`) for those
exact inputs gives spendable = 9000 - 1380 = 7620, and floor(7620 / 27) = 282, not 281 — 27*282 =
7614 <= 7620 < 7641 = 27*283. There is no reading of "10 percent reserve" or "27 days left" that
makes the formula land on 281 for these inputs; this looks like an arithmetic slip in the ticket's
own illustrative example, not a different intended formula. Implemented (and tested) to the
literal formula, which is unambiguous; flagged on the ticket rather than guessing at a different
algorithm to force a match.
"""
import datetime
import json
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


class ComputeTodayAllowance(unittest.TestCase):
    def test_the_formula_worked_example(self):
        # See module docstring: 282 is what the ticket's own formula gives for these inputs.
        self.assertEqual(pp.compute_wm_today_allowance(10000, 10, 1380, 27), 282)

    def test_zero_spent_one_day_left_is_the_whole_spendable_pot_not_a_fraction(self):
        # spendable = 10000*0.9 - 0 = 9000; with 1 day left that whole pot is today's allowance.
        self.assertEqual(pp.compute_wm_today_allowance(10000, 10, 0, 1), 9000)

    def test_quadrupling_the_quota_quadruples_the_allowance_with_nothing_else_changed(self):
        base = pp.compute_wm_today_allowance(10000, 10, 0, 30)
        quadrupled = pp.compute_wm_today_allowance(40000, 10, 0, 30)
        self.assertEqual(quadrupled, base * 4)

    def test_no_days_left_never_divides_by_zero(self):
        self.assertEqual(pp.compute_wm_today_allowance(10000, 10, 0, 0), 0)

    def test_an_exhausted_cycle_floors_at_zero_not_negative(self):
        self.assertEqual(pp.compute_wm_today_allowance(10000, 10, 9500, 5), 0)


class SplitWmPot(unittest.TestCase):
    """AC3 — a run that reaches the allowance (pot=0) hands every pass a cap of 0, so none of
    them makes another Watchmode call; enrich_watchmode_fields/build_live_catalogue/
    probe_candidates already treat a 0 budget as a clean skip (see their own tests), so this only
    has to prove the split itself starves every pass at once rather than favouring one."""

    def test_an_exhausted_pot_gives_every_pass_a_zero_cap(self):
        self.assertEqual(pp.split_wm_pot(0, 400, 15, 200), (0, 0, 0))

    def test_the_three_caps_always_sum_to_the_whole_pot(self):
        ondemand, nightly, scoreability = pp.split_wm_pot(281, 400, 15, 200)
        self.assertEqual(ondemand + nightly + scoreability, 281)

    def test_the_split_follows_the_weights_ratio(self):
        # weights 400:15:200 (615 total) against a pot of 615 should recover the old fixed pots.
        ondemand, nightly, scoreability = pp.split_wm_pot(615, 400, 15, 200)
        self.assertEqual((ondemand, nightly, scoreability), (15, 400, 200))

    def test_zero_weights_hand_the_whole_pot_to_scoreability_rather_than_dividing_by_zero(self):
        self.assertEqual(pp.split_wm_pot(100, 0, 0, 0), (0, 0, 100))


class WmCycleBounds(unittest.TestCase):
    def test_today_on_the_reset_day_starts_a_new_cycle(self):
        start, end = pp._wm_cycle_bounds(datetime.date(2026, 10, 12), reset_day=12)
        self.assertEqual(start, datetime.date(2026, 10, 12))
        self.assertEqual(end, datetime.date(2026, 11, 12))

    def test_today_after_the_reset_day_is_the_current_months_cycle(self):
        # the ticket's own dashboard read: 2026-09-15 (past this month's 12th reset), resets
        # next on 2026-10-12 -> 27 days left.
        start, end = pp._wm_cycle_bounds(datetime.date(2026, 9, 15), reset_day=12)
        self.assertEqual(start, datetime.date(2026, 9, 12))
        self.assertEqual(end, datetime.date(2026, 10, 12))
        self.assertEqual((end - datetime.date(2026, 9, 15)).days, 27)

    def test_today_before_the_reset_day_is_still_in_last_months_cycle(self):
        start, end = pp._wm_cycle_bounds(datetime.date(2026, 9, 5), reset_day=12)
        self.assertEqual(start, datetime.date(2026, 8, 12))
        self.assertEqual(end, datetime.date(2026, 9, 12))

    def test_a_reset_day_past_a_short_months_length_clamps_to_its_last_day(self):
        start, end = pp._wm_cycle_bounds(datetime.date(2027, 2, 20), reset_day=31)
        self.assertEqual(start, datetime.date(2027, 1, 31))
        self.assertEqual(end, datetime.date(2027, 2, 28))


class WmCycleBudgetFileHandling(unittest.TestCase):
    def _budget_path(self, tmp):
        return os.path.join(tmp, "api_budget.json")

    def test_a_missing_file_starts_a_fresh_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(pp, "API_BUDGET_FILE", self._budget_path(tmp)), \
                 mock.patch.object(pp, "WM_MONTHLY_QUOTA", 10000):
                cycle = pp._load_wm_cycle_budget(datetime.date(2026, 9, 15))
        self.assertEqual(cycle["spent"], 0)
        self.assertEqual(cycle["days"], {})
        self.assertEqual(cycle["quota"], 10000)

    def test_the_pre_cas987_date_wm_spent_shape_migrates_without_raising(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._budget_path(tmp)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"date": "2026-09-14", "wm_spent": 40}, fh)
            with mock.patch.object(pp, "API_BUDGET_FILE", path):
                cycle = pp._load_wm_cycle_budget(datetime.date(2026, 9, 15))   # must not raise
        self.assertEqual(cycle["spent"], 0)
        self.assertEqual(cycle["days"], {})

    def test_crossing_the_reset_day_starts_a_new_cycle_and_discards_the_old_days_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._budget_path(tmp)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"cycle_start": "2026-08-12", "cycle_end": "2026-10-12",
                          "quota": 10000, "spent": 900, "updated_at": "2026-10-11",
                          "days": {"2026-10-11": 900}}, fh)
            with mock.patch.object(pp, "API_BUDGET_FILE", path):
                cycle = pp._load_wm_cycle_budget(datetime.date(2026, 10, 13))   # past the reset day
        self.assertEqual(cycle["cycle_start"], "2026-10-12")
        self.assertEqual(cycle["spent"], 0)
        self.assertEqual(cycle["days"], {})

    def test_still_inside_the_same_cycle_keeps_the_days_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._budget_path(tmp)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"cycle_start": "2026-08-12", "cycle_end": "2026-10-12",
                          "quota": 10000, "spent": 500, "updated_at": "2026-09-14",
                          "days": {"2026-09-14": 500}}, fh)
            with mock.patch.object(pp, "API_BUDGET_FILE", path):
                cycle = pp._load_wm_cycle_budget(datetime.date(2026, 9, 15))
        self.assertEqual(cycle["days"], {"2026-09-14": 500})
        self.assertEqual(cycle["spent"], 500)

    def test_save_then_load_round_trips_and_recomputes_spent_from_the_days_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._budget_path(tmp)
            today = datetime.date(2026, 9, 15)
            with mock.patch.object(pp, "API_BUDGET_FILE", path):
                cycle = pp._load_wm_cycle_budget(today)
                cycle["days"][today.isoformat()] = 123
                pp._save_wm_cycle_budget(cycle, today)
                reloaded = pp._load_wm_cycle_budget(today)
        self.assertEqual(reloaded["spent"], 123)
        self.assertEqual(reloaded["days"], {"2026-09-15": 123})


if __name__ == "__main__":
    unittest.main()
