"""CAS-990 — the Watchmode changes-endpoints cost spike (scripts/wm_changes_spike.py).

The endpoints' real row shape is unconfirmed anywhere in this codebase (CAS-882's own probe never
got a live run back), so `_extract_rows`/`_row_id` are tested directly against several plausible
shapes. The full-run tests exercise `run()` against small fixture files on disk (never the real
movies.json/state/*) with --dry-run, so no network call happens and the numbers are hand-checkable.
"""
import datetime
import json
import os
import sys
import tempfile
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
import wm_changes_spike as spike  # noqa: E402


def _fixture_files(tmpdir, today: datetime.date):
    """Four published titles: Alpha/Beta/Gamma resolve to Watchmode ids 101/202/303 (the recent
    day's details-changed fixture ids), Delta resolves to 404 (the recent day's sources-changed
    fixture id, but not details-changed). Delta's wm_fields_fetched_at is absent, so it is the one
    title that qualifies for measurement 3's group B (stale, outside the 30-day details union)."""
    stale = (today - datetime.timedelta(days=25)).isoformat()
    movies = {
        "movies": [
            {"tmdb_id": 1, "imdb_id": "tt1", "title": "Alpha",
             "wm_user_rating": 7.0, "wm_critic_score": 55, "wm_fields_fetched_at": stale},
            {"tmdb_id": 2, "imdb_id": "tt2", "title": "Beta",
             "wm_user_rating": 6.5, "wm_critic_score": 60, "wm_fields_fetched_at": stale},
            {"tmdb_id": 3, "imdb_id": "tt3", "title": "Gamma",
             "wm_user_rating": None, "wm_critic_score": None, "wm_fields_fetched_at": stale},
            {"tmdb_id": 4, "imdb_id": "tt4", "title": "Delta",
             "wm_user_rating": 5.0, "wm_critic_score": 40, "wm_fields_fetched_at": None},
        ]
    }
    wm_ids = {"tt1": "101", "tt2": "202", "tt3": "303", "tt4": "404"}
    candidates = {"9202": {"tmdb_id": 9202, "title": "Candidate Only"}}

    movies_path = os.path.join(tmpdir, "movies.json")
    wm_ids_path = os.path.join(tmpdir, "watchmode_ids.json")
    candidates_path = os.path.join(tmpdir, "candidates.json")
    doc_path = os.path.join(tmpdir, "cas-watchmode-changes-spike.md")
    with open(movies_path, "w", encoding="utf-8") as fh:
        json.dump(movies, fh)
    with open(wm_ids_path, "w", encoding="utf-8") as fh:
        json.dump(wm_ids, fh)
    with open(candidates_path, "w", encoding="utf-8") as fh:
        json.dump(candidates, fh)
    return movies_path, wm_ids_path, candidates_path, doc_path


class ExtractRowsTestCase(unittest.TestCase):
    """The row shape is unconfirmed (see module docstring) — every plausible key name must work."""

    def test_tries_each_known_list_key(self):
        for key in ("changes", "titles", "results", "items", "title_id_changes"):
            with self.subTest(key=key):
                self.assertEqual(spike._extract_rows({key: [1, 2]}), [1, 2])

    def test_prefers_earlier_key_when_several_present(self):
        self.assertEqual(spike._extract_rows({"titles": [1], "changes": [2]}), [2])

    def test_no_known_key_returns_empty(self):
        self.assertEqual(spike._extract_rows({"total_results": 5}), [])

    def test_non_dict_input_returns_empty(self):
        self.assertEqual(spike._extract_rows(None), [])


class RowIdTestCase(unittest.TestCase):
    def test_raw_id_stringified(self):
        self.assertEqual(spike._row_id(1596439), "1596439")

    def test_dict_row_tries_id_then_title_id_then_wm_id(self):
        self.assertEqual(spike._row_id({"id": 5}), "5")
        self.assertEqual(spike._row_id({"title_id": 6}), "6")
        self.assertEqual(spike._row_id({"wm_id": 7}), "7")

    def test_dict_row_with_no_known_key_is_empty(self):
        self.assertEqual(spike._row_id({"unrelated": 1}), "")


class BudgetTestCase(unittest.TestCase):
    def test_live_budget_reports_real_calls_and_stops_at_cap(self):
        b = spike.Budget(2, dry_run=False)
        self.assertTrue(b.take())
        self.assertTrue(b.take())
        self.assertFalse(b.take())
        self.assertTrue(b.stopped)
        self.assertEqual(b.credits_spent, 2)

    def test_dry_run_budget_still_stops_at_cap_but_reports_zero(self):
        b = spike.Budget(1, dry_run=True)
        self.assertTrue(b.take())
        self.assertFalse(b.take())
        self.assertTrue(b.stopped)
        self.assertEqual(b.credits_spent, 0)


class FetchStaleTestCase(unittest.TestCase):
    def test_missing_stamp_is_stale(self):
        self.assertTrue(spike._fetch_stale({}, datetime.date(2026, 9, 16)))

    def test_stamp_past_threshold_is_stale(self):
        movie = {"wm_fields_fetched_at": "2026-08-01"}
        self.assertTrue(spike._fetch_stale(movie, datetime.date(2026, 9, 16)))

    def test_stamp_within_threshold_is_not_stale(self):
        movie = {"wm_fields_fetched_at": "2026-09-10"}
        self.assertFalse(spike._fetch_stale(movie, datetime.date(2026, 9, 16)))


class DryRunFullDocTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        today = datetime.datetime.now(datetime.timezone.utc).date()
        (self.movies_path, self.wm_ids_path, self.candidates_path,
         self.doc_path) = _fixture_files(self._tmpdir.name, today)

    def test_writes_all_five_measurement_sections_with_zero_credits_shown(self):
        result = spike.run(50, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=self.candidates_path, doc_path=self.doc_path)
        self.assertEqual(result["credits_spent"], 0)
        with open(self.doc_path, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("Credits spent: 0", doc)
        self.assertIn("## 1. Seven-day counts", doc)
        self.assertIn("## 2. Most-recent-day breakdown", doc)
        self.assertIn("## 3. Score sensitivity", doc)
        self.assertIn("## 4. One-month credit comparison", doc)
        self.assertIn("## What could not be established", doc)

    def test_classifies_published_and_candidate_ids_on_the_recent_day(self):
        result = spike.run(50, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=self.candidates_path, doc_path=self.doc_path)
        m2 = result["m2"]
        # all four fixture titles are published, and all four wm ids (101/202/303 from
        # details-changed, 202/404 from sources-changed) appear in the union
        self.assertEqual(m2["all_ids_count"], 4)
        self.assertEqual(m2["published_changed_count"], 4)
        # only wm id 202 -> tmdb 9202 is in the fixture candidates.json
        self.assertEqual(m2["candidate_changed_count"], 1)

    def test_score_sensitivity_groups(self):
        result = spike.run(50, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=self.candidates_path, doc_path=self.doc_path)
        m3 = result["m3"]
        # group A: published titles inside the recent day's details-changed set (101/202/303)
        self.assertEqual(m3["in_details_changed"]["candidates"], 3)
        # group B: published titles outside the 30-day details union with no cached fetch date —
        # only Delta (404) qualifies
        self.assertEqual(m3["stale_and_unchanged_30d"]["candidates"], 1)

    def test_absent_candidates_file_is_not_an_error(self):
        missing = os.path.join(self._tmpdir.name, "does-not-exist.json")
        result = spike.run(50, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=missing, doc_path=self.doc_path)
        self.assertEqual(result["m2"]["candidate_changed_count"], 0)


class MaxCreditsStopsEarlyTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        today = datetime.datetime.now(datetime.timezone.utc).date()
        (self.movies_path, self.wm_ids_path, self.candidates_path,
         self.doc_path) = _fixture_files(self._tmpdir.name, today)

    def test_a_cap_below_the_calls_needed_stops_the_run_cleanly(self):
        result = spike.run(1, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=self.candidates_path, doc_path=self.doc_path)
        self.assertTrue(result["stopped"])
        # still reports zero in a dry run even though the cap really did bite
        self.assertEqual(result["credits_spent"], 0)
        with open(self.doc_path, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("Stopped early", doc)
        # every section still gets written, even if some are based on partial data
        self.assertIn("## 1. Seven-day counts", doc)
        self.assertIn("## 4. One-month credit comparison", doc)

    def test_a_generous_cap_never_stops(self):
        result = spike.run(1000, True, movies_path=self.movies_path, wm_ids_path=self.wm_ids_path,
                            candidates_path=self.candidates_path, doc_path=self.doc_path)
        self.assertFalse(result["stopped"])


if __name__ == "__main__":
    unittest.main()
