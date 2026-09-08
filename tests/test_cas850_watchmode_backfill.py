"""CAS-850 - the Watchmode fields backfill script (scripts/cas850_watchmode_backfill.py).

Every network seam is monkeypatched on poc_pipeline directly (the script imports that module),
so no test here makes a live HTTP call. The catalogue path is a temp file per test, so tests
never touch the real movies.json.
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import cas850_watchmode_backfill as backfill  # noqa: E402

import poc_pipeline as pp

FIXTURE_MOVIES = [
    {"tmdb_id": 100, "title": "A"},   # resolves via idmap
    {"tmdb_id": 200, "title": "B"},   # resolves via idmap
    {"tmdb_id": 300, "title": "C"},   # absent from idmap
]
FIXTURE_IDMAP = {"wm100": 100, "wm200": 200}   # wm_id -> tmdb_id, as _fetch_watchmode_idmap returns
FIXTURE_DETAIL = {"user_rating": 7.5, "critic_score": 60, "popularity_percentile": 80.0}


class Cas850BackfillTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        self._write_catalogue(FIXTURE_MOVIES)

    def _write_catalogue(self, movies):
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": movies}, fh)

    def _read_catalogue(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            return json.load(fh)["movies"]

    def test_resolved_titles_are_enriched_and_the_unresolved_title_is_left_untouched(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10)

        movies = self._read_catalogue()
        by_id = {m["tmdb_id"]: m for m in movies}
        for tmdb_id in (100, 200):
            self.assertEqual(by_id[tmdb_id]["wm_user_rating"], 7.5)
            self.assertEqual(by_id[tmdb_id]["wm_fields_fetched_at"], pp._RUN_DATE)
        self.assertNotIn("wm_user_rating", by_id[300])
        self.assertNotIn("wm_fields_fetched_at", by_id[300])

        self.assertEqual(counts["titles enriched"], 2)
        self.assertEqual(counts["titles with no Watchmode id"], 1)
        self.assertEqual(counts["titles skipped for budget"], 0)
        self.assertEqual(counts["credits spent"], 2)

    def test_stdout_prints_all_four_counts(self):
        import io
        from contextlib import redirect_stdout
        out = io.StringIO()
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)), \
             redirect_stdout(out):
            backfill.run(catalogue_path=self.catalogue_path, max_credits=10)
        printed = out.getvalue()
        for label in ("titles enriched", "titles skipped for budget",
                      "titles with no Watchmode id", "credits spent"):
            self.assertIn(label, printed)

    def test_a_rerun_immediately_after_a_successful_pass_is_a_no_op(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            backfill.run(catalogue_path=self.catalogue_path, max_credits=10)

            with mock.patch.object(pp, "_fetch_watchmode_title_details",
                                   side_effect=AssertionError("must not re-fetch a fresh record")):
                counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10)

        self.assertEqual(counts["titles enriched"], 0)
        self.assertEqual(counts["credits spent"], 0)


if __name__ == "__main__":
    unittest.main()
