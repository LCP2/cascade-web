"""CAS-989 — the Watchmode back-catalogue sizing script (scripts/wm_backcatalogue_sizing.py).

The --dry-run tests assert `pp.get_json` is never called at all (it's patched to raise), proving
dry-run genuinely makes no network call and instead runs off the script's own recorded fixture.
The live-path tests patch `pp.get_json` directly, same seam every other scripts/ test in this
repo uses (see tests/test_cas984_oscarbase_backfill.py) — no real HTTP call in this suite.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
import wm_backcatalogue_sizing as sizing  # noqa: E402

import poc_pipeline as pp


def _never_call(*args, **kwargs):
    raise AssertionError("dry-run must not call the network")


class ParseRatingGatesTestCase(unittest.TestCase):
    def test_zero_means_no_gate_others_pass_through_as_floats(self):
        self.assertEqual(sizing.parse_rating_gates("0,5.5,6.5"), [None, 5.5, 6.5])

    def test_blank_tokens_are_ignored(self):
        self.assertEqual(sizing.parse_rating_gates(" 0 , 6.5 ,"), [None, 6.5])

    def test_gate_label(self):
        self.assertEqual(sizing.gate_label(None), "no gate")
        self.assertEqual(sizing.gate_label(5.5), "user_rating_low=5.5")


class CandidateRowTestCase(unittest.TestCase):
    def test_extracts_exactly_the_five_required_fields(self):
        title = {"id": 1, "title": "T", "year": 2020, "imdb_id": "tt1", "tmdb_id": 55,
                  "tmdb_type": "movie", "type": "movie", "popularity_percentile": 70,
                  "extra_field": "ignored"}
        row = sizing._candidate_row(title)
        self.assertEqual(row, {"id": 1, "tmdb_id": 55, "year": 2020, "title": "T",
                                "popularity_percentile": 70})


class MergeCandidatesTestCase(unittest.TestCase):
    def test_new_ids_are_added(self):
        merged, added, updated = sizing.merge_candidates([], [{"id": 1}, {"id": 2}])
        self.assertEqual(added, 2)
        self.assertEqual(updated, 0)
        self.assertEqual(len(merged), 2)

    def test_rerun_with_identical_rows_adds_and_updates_nothing(self):
        existing = [{"id": 1, "title": "A"}]
        merged, added, updated = sizing.merge_candidates(existing, [{"id": 1, "title": "A"}])
        self.assertEqual(added, 0)
        self.assertEqual(updated, 0)
        self.assertEqual(len(merged), 1)

    def test_a_changed_row_updates_in_place_without_duplicating(self):
        existing = [{"id": 1, "title": "A", "popularity_percentile": 10}]
        merged, added, updated = sizing.merge_candidates(
            existing, [{"id": 1, "title": "A", "popularity_percentile": 20}])
        self.assertEqual(added, 0)
        self.assertEqual(updated, 1)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["popularity_percentile"], 20)


class DryRunByYearTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.doc_path = os.path.join(self._tmpdir.name, "cas-backcatalogue-by-year.md")

    def test_makes_no_network_call_and_writes_the_expected_counts(self):
        with mock.patch.object(pp, "get_json", side_effect=_never_call):
            result = sizing.run_by_year(2020, 2021, [None, 5.5, 6.5], max_credits=100,
                                        doc_path=self.doc_path, dry_run=True)
        self.assertEqual(result["credits_spent"], 6)
        self.assertIsNone(result["stopped_at"])
        with open(self.doc_path, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("| 2020 | 812 | 340 | 145 |", doc)
        self.assertIn("| 2021 | 790 | 322 | 138 |", doc)
        self.assertIn("Credits spent: 6", doc)


class DryRunEnumerateTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.out_path = os.path.join(self._tmpdir.name, "wm_backcatalogue_candidates.json")

    def test_makes_no_network_call_and_writes_both_fixture_titles(self):
        with mock.patch.object(pp, "get_json", side_effect=_never_call):
            result = sizing.run_enumerate(2020, 2021, [None], max_credits=10,
                                          out_path=self.out_path, dry_run=True)
        self.assertEqual(result["added"], 2)
        self.assertEqual(result["total"], 2)
        with open(self.out_path, encoding="utf-8") as fh:
            candidates = json.load(fh)
        self.assertEqual({c["id"] for c in candidates}, {1001, 1002})
        for c in candidates:
            self.assertEqual(set(c), {"id", "tmdb_id", "year", "title", "popularity_percentile"})

    def test_rerun_is_idempotent(self):
        with mock.patch.object(pp, "get_json", side_effect=_never_call):
            sizing.run_enumerate(2020, 2021, [None], max_credits=10, out_path=self.out_path,
                                 dry_run=True)
            second = sizing.run_enumerate(2020, 2021, [None], max_credits=10,
                                          out_path=self.out_path, dry_run=True)
        self.assertEqual(second["added"], 0)
        self.assertEqual(second["updated"], 0)
        self.assertEqual(second["total"], 2)


class MaxCreditsByYearTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.doc_path = os.path.join(self._tmpdir.name, "doc.md")

    def test_stops_cleanly_once_the_ceiling_is_reached(self):
        with mock.patch.object(pp, "get_json", return_value={"total_results": 5}):
            result = sizing.run_by_year(2020, 2029, [None, 5.5, 6.5], max_credits=2,
                                        doc_path=self.doc_path, dry_run=False)
        self.assertEqual(result["credits_spent"], 2)
        self.assertEqual(result["stopped_at"], (2020, 6.5))
        # only the one (partial) year row was written, not all ten requested years
        self.assertEqual(len(result["rows"]), 1)
        with open(self.doc_path, encoding="utf-8") as fh:
            doc = fh.read()
        self.assertIn("Stopped early at year=2020", doc)


class MaxCreditsEnumerateTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.out_path = os.path.join(self._tmpdir.name, "candidates.json")

    def test_stops_cleanly_before_exhausting_all_pages(self):
        page_response = {"titles": [{"id": 1, "tmdb_id": 1, "year": 2020, "title": "X",
                                      "popularity_percentile": 5}],
                          "total_pages": 3}
        with mock.patch.object(pp, "get_json", return_value=page_response):
            result = sizing.run_enumerate(2020, 2020, [None], max_credits=1,
                                          out_path=self.out_path, dry_run=False)
        self.assertTrue(result["stopped"])
        self.assertEqual(result["credits_spent"], 1)
        self.assertEqual(result["total"], 1)


class LiveUrlShapeTestCase(unittest.TestCase):
    """Confirms the request params this script sends match the ticket's own readout of the
    OpenAPI spec: regions=AU, types=movie, release_date_start/end bounding the year(s), the
    right gate param (or none for "no gate"), and limit=1 for a count-only call."""

    def test_count_call_omits_user_rating_low_for_the_no_gate_case(self):
        seen = {}

        def fake_get_json(url):
            seen["url"] = url
            return {"total_results": 42}

        with mock.patch.object(pp, "get_json", side_effect=fake_get_json):
            sizing.fetch_year_count(1975, None, dry_run=False)
        self.assertIn("regions=AU", seen["url"])
        self.assertIn("release_date_start=19750101", seen["url"])
        self.assertIn("release_date_end=19751231", seen["url"])
        self.assertIn("limit=1", seen["url"])
        self.assertNotIn("user_rating_low", seen["url"])

    def test_count_call_carries_the_gate_when_one_is_given(self):
        seen = {}

        def fake_get_json(url):
            seen["url"] = url
            return {"total_results": 1}

        with mock.patch.object(pp, "get_json", side_effect=fake_get_json):
            sizing.fetch_year_count(1975, 5.5, dry_run=False)
        self.assertIn("user_rating_low=5.5", seen["url"])

    def test_enumerate_call_uses_limit_250(self):
        seen = {}

        def fake_get_json(url):
            seen["url"] = url
            return {"titles": [], "total_pages": 1}

        with mock.patch.object(pp, "get_json", side_effect=fake_get_json):
            sizing.fetch_titles_page(1930, 2026, None, 1, dry_run=False)
        self.assertIn("limit=250", seen["url"])
        self.assertIn("sort_by=popularity_desc", seen["url"])


if __name__ == "__main__":
    unittest.main()
