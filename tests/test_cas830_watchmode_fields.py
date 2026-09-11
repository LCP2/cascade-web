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
    """AC3 — with a shared budget of 2 credits and 5 candidate titles, exactly 2 are enriched and
    the budget reports 3 skipped."""

    def test_the_budget_caps_how_many_titles_are_enriched_and_reports_the_rest_skipped(self):
        catalogue = [{"tmdb_id": i} for i in range(1, 6)]
        wm_idmap = {i: str(100 + i) for i in range(1, 6)}
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        budget = {"remaining": 2, "skipped": 0}
        with mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            enriched = sum(1 for m in catalogue
                           if pp.enrich_watchmode_fields(m, wm_idmap, budget) == "ok")
        self.assertEqual(enriched, 2)
        self.assertEqual(sum(1 for m in catalogue if "wm_user_rating" in m), 2)
        self.assertEqual(budget["skipped"], 3)


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


class EnrichWatchmodeFieldsNightlyPriorityOrder(unittest.TestCase):
    """CAS-921 AC2 — 3 new titles, 3 stale ladder-cohort titles and 3 stale other titles, with a
    budget of 4: exactly the 3 new titles and 1 cohort title are fetched, highest priority first."""

    def test_new_titles_then_cohort_titles_spend_the_budget_first(self):
        import datetime
        today = datetime.date.fromisoformat(pp._RUN_DATE)
        cohort_stamp = (today - datetime.timedelta(days=10)).isoformat()   # >=7, <30
        other_stamp = (today - datetime.timedelta(days=40)).isoformat()    # >=30

        new_titles = [{"tmdb_id": i, "status": []} for i in range(1, 4)]
        cohort_titles = [{"tmdb_id": i, "status": ["upcoming"], "wm_fields_fetched_at": cohort_stamp}
                          for i in range(4, 7)]
        other_titles = [{"tmdb_id": i, "status": [], "wm_fields_fetched_at": other_stamp}
                         for i in range(7, 10)]
        movies = new_titles + cohort_titles + other_titles
        wm_idmap = {i: str(100 + i) for i in range(1, 10)}
        detail = {"user_rating": 5.0, "critic_score": 50, "popularity_percentile": 50.0}
        budget = {"remaining": 4, "skipped": 0}

        with mock.patch.object(pp, "WATCHMODE_KEY", "test-key"), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                                return_value={v: k for k, v in wm_idmap.items()}), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=detail):
            outcomes = pp.enrich_watchmode_fields_nightly(movies, budget=budget)

        self.assertEqual(outcomes["ok"], 4)
        self.assertTrue(all("wm_user_rating" in m for m in new_titles))
        self.assertEqual(sum(1 for m in cohort_titles if "wm_user_rating" in m
                              and m["wm_fields_fetched_at"] == pp._RUN_DATE), 1)
        self.assertTrue(all("wm_user_rating" not in m for m in other_titles))
        self.assertEqual(budget["remaining"], 0)


class EnrichWatchmodeFieldsNightlyMissingKey(unittest.TestCase):
    """CAS-921 AC3 — with WATCHMODE_API_KEY unset, the nightly step returns without raising and
    prints a line starting [warn]."""

    def test_missing_key_warns_and_returns_without_raising(self):
        movies = [{"tmdb_id": 1, "status": []}]
        with mock.patch.object(pp, "WATCHMODE_KEY", None), \
             mock.patch.object(pp, "_fetch_watchmode_idmap",
                                side_effect=AssertionError("must not call Watchmode")), \
             mock.patch("builtins.print") as mock_print:
            outcomes = pp.enrich_watchmode_fields_nightly(movies)
        self.assertEqual(outcomes, {"ok": 0, "cached": 0, "no-id": 0, "skip": 0, "stop": 0})
        printed = [call.args[0] for call in mock_print.call_args_list]
        self.assertTrue(any(line.startswith("[warn]") for line in printed))


if __name__ == "__main__":
    unittest.main()
