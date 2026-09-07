"""CAS-830 — v2 phase 3: source Watchmode user_rating, critic_score and popularity_percentile
onto the catalogue (additive only).

Nothing here reads these fields anywhere else — not cascadeScore, not qScore, not the agents,
not any filter or sort. Every test mocks the network; no live Watchmode call is ever made.
"""
import unittest
from unittest import mock

import poc_pipeline as pp


class InvertWatchmodeIdmap(unittest.TestCase):
    """`_fetch_watchmode_idmap` returns {wm_id: tmdb_id}; the fields backfill needs the inverse."""

    def test_the_map_is_inverted(self):
        self.assertEqual(pp._invert_watchmode_idmap({"100": 555, "101": 556}),
                         {555: "100", 556: "101"})


class EnrichWatchmodeFieldsWritesRatings(unittest.TestCase):
    """AC2 — the details endpoint is monkeypatched; a record gains all three fields, and a
    response with no critic_score key yields None, not 0 and not an absent key."""

    def test_a_full_response_writes_all_three_fields(self):
        movie = {"tmdb_id": 555}
        detail = {"user_rating": 7.8, "critic_score": 64, "popularity_percentile": 91.2}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcome = pp.enrich_watchmode_fields(movie, {555: "100"}, budget)
        self.assertEqual(outcome, "ok")
        self.assertEqual(movie["wm_user_rating"], 7.8)
        self.assertEqual(movie["wm_critic_score"], 64)
        self.assertEqual(movie["wm_popularity_percentile"], 91.2)
        self.assertEqual(movie["wm_fields_fetched_at"], pp._RUN_DATE)
        self.assertEqual(budget["remaining"], 4)

    def test_a_response_missing_critic_score_yields_none_not_zero_or_absent(self):
        movie = {"tmdb_id": 555}
        detail = {"user_rating": 7.8, "popularity_percentile": 91.2}   # no critic_score key
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            pp.enrich_watchmode_fields(movie, {555: "100"}, budget)
        self.assertIn("wm_critic_score", movie)
        self.assertIsNone(movie["wm_critic_score"])

    def test_a_title_with_no_resolvable_watchmode_id_is_not_called_and_left_alone(self):
        movie = {"tmdb_id": 555}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details",
                               side_effect=AssertionError("must not call Watchmode")):
            outcome = pp.enrich_watchmode_fields(movie, {}, budget)
        self.assertEqual(outcome, "no-id")
        self.assertNotIn("wm_user_rating", movie)
        self.assertEqual(budget["remaining"], 5)


class EnrichWatchmodeFieldsBudget(unittest.TestCase):
    """AC3 — with WM_FIELDS_MAX_CREDITS=2 and 5 candidate titles, exactly 2 are enriched and the
    run reports 3 skipped."""

    def test_the_budget_caps_how_many_titles_are_enriched_and_reports_the_rest_skipped(self):
        catalogue = [{"tmdb_id": i} for i in range(1, 6)]
        wm_idmap = {i: str(100 + i) for i in range(1, 6)}
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        import io
        from contextlib import redirect_stdout
        out = io.StringIO()
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            with redirect_stdout(out):
                enriched = pp.backfill_watchmode_fields(catalogue, wm_idmap, max_credits=2)
        self.assertEqual(enriched, 2)
        self.assertEqual(sum(1 for m in catalogue if "wm_user_rating" in m), 2)
        self.assertIn("skipped 3", out.getvalue())


class EnrichWatchmodeFieldsRefetchPolicy(unittest.TestCase):
    """AC4 — a record whose wm_fields_fetched_at is inside WATCHMODE_CACHE_TTL_DAYS is not
    re-fetched; one past it is."""

    def test_a_record_5_days_old_is_not_re_fetched(self):
        import datetime
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        stamp = (today - datetime.timedelta(days=5)).isoformat()
        movie = {"tmdb_id": 555, "wm_user_rating": 6.0, "wm_fields_fetched_at": stamp}
        budget = {"remaining": 5, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details",
                               side_effect=AssertionError("must not re-fetch a fresh record")):
            outcome = pp.enrich_watchmode_fields(movie, {555: "100"}, budget)
        self.assertEqual(outcome, "cached")
        self.assertEqual(movie["wm_user_rating"], 6.0)
        self.assertEqual(budget["remaining"], 5)

    def test_a_record_40_days_old_is_re_fetched(self):
        import datetime
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        stamp = (today - datetime.timedelta(days=40)).isoformat()
        movie = {"tmdb_id": 555, "wm_user_rating": 6.0, "wm_fields_fetched_at": stamp}
        budget = {"remaining": 5, "skipped": 0}
        detail = {"user_rating": 8.0, "critic_score": 70, "popularity_percentile": 60.0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcome = pp.enrich_watchmode_fields(movie, {555: "100"}, budget)
        self.assertEqual(outcome, "ok")
        self.assertEqual(movie["wm_user_rating"], 8.0)
        self.assertEqual(movie["wm_fields_fetched_at"], pp._RUN_DATE)


if __name__ == "__main__":
    unittest.main()
