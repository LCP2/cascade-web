"""CAS-986 — the two-tier catalogue: a candidate pool (state/candidates.json), and publish only
titles that carry a score (movies.json).

Two files, not one: candidates.json is every title discovery has ever found (never shipped, never
pruned); movies.json is the strict subset that can carry a Cascade score today, capped at
CATALOGUE_TARGET. This exercises the pure Python side of that split — merge/refresh into the
candidates store, the tiered probe budget, the publish/demote decision and its exemption list —
plus the real engine call (scoreable_ids), since that is the one piece with no meaningful stub.
"""
import datetime
import json
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


def _movie(tmdb_id, popularity=100, status=("included_streaming",), **fields):
    m = {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026", "popularity": popularity,
         "status": list(status), "offers": [], "cinema_date": "2026-01-01"}
    m.update(fields)
    return m


class ScoreableIdsRealEngine(unittest.TestCase):
    """AC2 — the publication test, run against the real shipped engine (no stub): a title with
    wm_user_rating is published; a settled streaming title with only wm_popularity_percentile is
    not; an upcoming title with only wm_popularity_percentile is."""

    def test_the_three_named_scenarios(self):
        released_with_rating = _movie(1, status=["included_streaming"], wm_user_rating=75)
        settled_buzz_only = _movie(2, status=["included_streaming"], wm_popularity_percentile=60)
        upcoming_buzz_only = _movie(3, status=["upcoming"], wm_popularity_percentile=60)
        ids = pp.scoreable_ids([released_with_rating, settled_buzz_only, upcoming_buzz_only])
        self.assertEqual(ids, {1, 3})


class MergeAndRefreshCandidates(unittest.TestCase):
    """AC1 — candidates.json never loses a record across runs."""

    def test_a_new_id_enters_as_unprobed(self):
        candidates = {}
        pp.merge_candidates(candidates, [_movie(10, 50)], "2026-09-15")
        self.assertEqual(candidates["10"]["outcome"], "unprobed")
        self.assertEqual(candidates["10"]["first_seen"], "2026-09-15")
        self.assertEqual(candidates["10"]["probe_count"], 0)

    def test_an_existing_id_is_not_re_added_or_reset_by_merge(self):
        candidates = {"10": {**_movie(10, 50), "first_seen": "2026-01-01", "last_probed": "2026-06-01",
                             "probe_count": 3, "outcome": "scored", "wm_user_rating": 80}}
        added = pp.merge_candidates(candidates, [_movie(10, 999)], "2026-09-15")
        self.assertEqual(added, 0)
        self.assertEqual(candidates["10"]["first_seen"], "2026-01-01")
        self.assertEqual(candidates["10"]["outcome"], "scored")

    def test_a_candidate_outside_this_runs_slice_is_left_untouched(self):
        candidates = {"10": {**_movie(10, 50, wm_user_rating=80), "first_seen": "2026-01-01",
                             "last_probed": "2026-06-01", "probe_count": 1, "outcome": "scored"}}
        # Not present in `enriched` at all this run (fell outside the slice).
        pp.refresh_enriched_candidates(candidates, [], "2026-09-15")
        self.assertEqual(candidates["10"]["outcome"], "scored")
        self.assertEqual(candidates["10"]["wm_user_rating"], 80)

    def test_a_probe_by_the_existing_cas921_pass_is_recognised_as_a_probe(self):
        """CAS-921's own nightly Watchmode-fields pass (unchanged, still wired into run()) may
        enrich a candidate under its own budget, independently of probe_candidates below —
        refresh_enriched_candidates must fold that into outcome/last_probed so the two never drift
        apart just because CAS-986's own probe never touched this candidate."""
        candidates = {"10": {**_movie(10, 50), "first_seen": "2026-01-01", "last_probed": None,
                             "probe_count": 0, "outcome": "unprobed"}}
        enriched = [_movie(10, 50, wm_user_rating=80, wm_fields_fetched_at="2026-09-15")]
        pp.refresh_enriched_candidates(candidates, enriched, "2026-09-15")
        self.assertEqual(candidates["10"]["outcome"], "scored")
        self.assertEqual(candidates["10"]["last_probed"], "2026-09-15")
        self.assertEqual(candidates["10"]["probe_count"], 1)

    def test_save_and_load_round_trip_loses_nothing(self):
        candidates = {"10": _movie(10, 50), "20": _movie(20, 30)}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "candidates.json")
            with mock.patch.object(pp, "CANDIDATES_FILE", path):
                pp.save_candidates(candidates)
                self.assertTrue(os.path.exists(path))
                loaded = pp.load_candidates()
        self.assertEqual(set(loaded), {"10", "20"})

    def test_load_candidates_with_no_file_yet_is_an_empty_dict_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(pp, "CANDIDATES_FILE", os.path.join(tmp, "nope.json")):
                self.assertEqual(pp.load_candidates(), {})


class ProbeCandidatesTierOrder(unittest.TestCase):
    """AC4 — with a stubbed allowance of 10, exactly 10 probes are made, and they follow the tier
    order: a stale published title is probed before an unprobed candidate."""

    def setUp(self):
        self.today = datetime.date(2026, 9, 15)
        self.calls = []

        def fake_enrich(movie_, wm_idmap, budget, ttl_days=pp.WATCHMODE_CACHE_TTL_DAYS):
            if budget["remaining"] <= 0:
                budget["skipped"] += 1
                return "skip"
            budget["remaining"] -= 1
            self.calls.append(movie_["tmdb_id"])
            movie_["wm_user_rating"] = 80
            movie_["wm_fields_fetched_at"] = self.today.isoformat()
            return "ok"

        patcher = mock.patch.object(pp, "enrich_watchmode_fields", fake_enrich)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_exactly_the_stubbed_allowance_is_spent(self):
        candidates = {}
        # 1 published+stale (tier 1), 20 unprobed (tier 2) — allowance of 10 must stop mid-tier-2.
        pub = _movie(1, 999, wm_fields_fetched_at="2025-01-01")   # long stale
        pp.merge_candidates(candidates, [pub], "2026-09-15")
        candidates["1"]["outcome"] = "scored"
        for i in range(2, 22):
            pp.merge_candidates(candidates, [_movie(i, 1000 - i)], "2026-09-15")

        outcomes = pp.probe_candidates(candidates, self.today, budget=10, wm_idmap={},
                                       published_ids={1})
        self.assertEqual(outcomes["probed"], 10)
        self.assertEqual(len(self.calls), 10)

    def test_a_stale_published_title_is_probed_before_an_unprobed_candidate(self):
        candidates = {}
        pub = _movie(1, 1, wm_fields_fetched_at="2025-01-01")   # low popularity, but published+stale
        pp.merge_candidates(candidates, [pub], "2026-09-15")
        candidates["1"]["outcome"] = "scored"
        # A far more popular unprobed candidate — would win on popularity alone if tiers were merged.
        pp.merge_candidates(candidates, [_movie(2, 99999)], "2026-09-15")

        pp.probe_candidates(candidates, self.today, budget=1, wm_idmap={}, published_ids={1})
        self.assertEqual(self.calls, [1])   # the published+stale title, not the popular unprobed one


class SelectPublishableDemotion(unittest.TestCase):
    """AC5/AC6/AC7 — demotion, its exemption list, and the never-probed guarantee."""

    def setUp(self):
        self.candidates = {str(i): _movie(i, 100 - i) for i in range(1, 6)}

    def test_a_title_that_loses_its_score_is_demoted(self):
        records, stats = pp.select_publishable(self.candidates, {1, 2, 3}, {2, 4}, held_ids=set(),
                                                catalogue_target=10)
        self.assertEqual(stats["demoted"], 1)
        self.assertEqual(stats["exempt"], 0)
        self.assertNotIn(4, {m["tmdb_id"] for m in records})

    def test_a_demoted_title_a_user_holds_is_kept_and_counted_exempt(self):
        records, stats = pp.select_publishable(self.candidates, {1, 2, 3}, {2, 4}, held_ids={4},
                                                catalogue_target=10)
        self.assertEqual(stats["demoted"], 0)
        self.assertEqual(stats["exempt"], 1)
        self.assertIn(4, {m["tmdb_id"] for m in records})

    def test_held_ids_none_means_demote_nothing_at_all(self):
        records, stats = pp.select_publishable(self.candidates, {1, 2, 3}, {2, 4}, held_ids=None,
                                                catalogue_target=10)
        self.assertEqual(stats["demoted"], 0)
        self.assertIn(4, {m["tmdb_id"] for m in records})

    def test_a_never_probed_candidate_is_never_published_or_demoted(self):
        self.candidates["6"] = _movie(6, 500)   # highest popularity, but never scoreable per engine
        records, stats = pp.select_publishable(self.candidates, {1, 2, 3}, {2}, held_ids=set(),
                                                catalogue_target=10)
        self.assertNotIn(6, {m["tmdb_id"] for m in records})
        self.assertEqual(stats["demoted"], 0)

    def test_catalogue_target_is_a_ceiling_on_the_scoreable_set(self):
        records, stats = pp.select_publishable(self.candidates, {1, 2, 3, 4, 5}, set(), held_ids=set(),
                                                catalogue_target=2)
        self.assertEqual(len(records), 2)
        self.assertEqual({m["tmdb_id"] for m in records}, {1, 2})   # top 2 by popularity


class LoadUserHeldIds(unittest.TestCase):
    """AC6 — with the user-state tables unreadable (the file absent), the caller sees None, the
    signal select_publishable already uses to demote nothing at all."""

    def test_a_missing_file_reads_as_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(pp, "USER_HELD_IDS_FILE", os.path.join(tmp, "nope.json")):
                self.assertIsNone(pp.load_user_held_ids())

    def test_an_unparseable_file_also_reads_as_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "user_held_ids.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("not json")
            with mock.patch.object(pp, "USER_HELD_IDS_FILE", path):
                self.assertIsNone(pp.load_user_held_ids())

    def test_a_real_file_reads_as_a_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "user_held_ids.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(["111", "222"], fh)
            with mock.patch.object(pp, "USER_HELD_IDS_FILE", path):
                self.assertEqual(pp.load_user_held_ids(), {"111", "222"})


class NoSecondCopyOfTheRule(unittest.TestCase):
    """AC3 — the publication test is obtained from the engine, not re-derived in Python: stub the
    engine's own answer and prove the pipeline follows it exactly, including a case the popularity-
    only slice would have gotten wrong on its own."""

    def test_the_pipeline_publishes_exactly_what_the_stubbed_engine_says(self):
        candidates = {
            "1": _movie(1, 999),   # most popular of all, but the stub says NOT scoreable
            "2": _movie(2, 1),     # least popular, but the stub says scoreable
        }
        with mock.patch.object(pp, "scoreable_ids", return_value={2}), \
             mock.patch.object(pp, "run_scoreability_probe",
                               return_value={"ok": 0, "cached": 0, "no-id": 0, "skip": 0,
                                             "stop": 0, "probed": 0}), \
             mock.patch.object(pp, "load_user_held_ids", return_value=set()):
            published, report = pp.apply_two_tier_publication(
                candidates, datetime.date(2026, 9, 15), [], [], previously_published_ids=set())
        self.assertEqual({m["tmdb_id"] for m in published}, {2})
        self.assertTrue(report["engine_ok"])

    def test_a_broken_engine_call_falls_back_to_the_previous_publish_set_unchanged(self):
        candidates = {"1": _movie(1, 100), "2": _movie(2, 50)}
        with mock.patch.object(pp, "scoreable_ids", side_effect=RuntimeError("node not found")), \
             mock.patch.object(pp, "run_scoreability_probe",
                               return_value={"ok": 0, "cached": 0, "no-id": 0, "skip": 0,
                                             "stop": 0, "probed": 0}), \
             mock.patch.object(pp, "load_user_held_ids", return_value=set()):
            published, report = pp.apply_two_tier_publication(
                candidates, datetime.date(2026, 9, 15), [], [], previously_published_ids={1})
        self.assertEqual({m["tmdb_id"] for m in published}, {1})
        self.assertFalse(report["engine_ok"])


class ReportFigures(unittest.TestCase):
    """AC9 — the run prints all seven figures; this asserts the dict they're built from carries
    each one, under exactly the name the ticket's own reporting line uses."""

    def test_the_report_carries_all_seven_names(self):
        candidates = {"1": _movie(1, 100)}
        with mock.patch.object(pp, "scoreable_ids", return_value={1}), \
             mock.patch.object(pp, "run_scoreability_probe",
                               return_value={"ok": 0, "cached": 0, "no-id": 0, "skip": 0,
                                             "stop": 0, "probed": 3}), \
             mock.patch.object(pp, "load_user_held_ids", return_value=set()):
            _, report = pp.apply_two_tier_publication(
                candidates, datetime.date(2026, 9, 15), [], [], previously_published_ids=set())
        for key in ("candidates", "unprobed", "probed_today", "published", "promoted",
                    "demoted", "exempt"):
            self.assertIn(key, report)


if __name__ == "__main__":
    unittest.main()
