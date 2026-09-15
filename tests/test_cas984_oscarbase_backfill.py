"""CAS-984 - the OscarBase awards backfill script (scripts/cas984_oscarbase_backfill.py).

Every network seam is monkeypatched on poc_pipeline directly (the script imports that module),
so no test here makes a live HTTP call. The catalogue/cache/snapshot paths are temp files per
test, so tests never touch the real movies.json / state/oscarbase_cache.json /
state/last_snapshot.json.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
import cas984_oscarbase_backfill as backfill  # noqa: E402

import poc_pipeline as pp

FIXTURE_MOVIES = [
    {"tmdb_id": 100, "title": "A"},   # OscarBase has a winning nomination
    {"tmdb_id": 200, "title": "B"},   # OscarBase has never heard of this film
    {"tmdb_id": 300, "title": "C"},   # already cached — must not be re-queried
]


def _listing(rows):
    return {"data": rows, "pagination": {"total": len(rows)}}


def _detail(nominations):
    return {"data": {"nominations": nominations}}


def _nom(category, nominee, winner, ceremony_year=2024):
    return {"category": category, "nominee": nominee, "winner": winner,
            "ceremony_year": ceremony_year}


def _get_json_for(fixture_101_wins=True):
    def get_json(url):
        if "tmdb_id=100" in url:
            return _listing([{"id": 1, "tmdb_id": 100, "title": "A"}])
        if "/api/movies/1" in url:
            return _detail([_nom("Directing", "Someone", True)])
        if "tmdb_id=200" in url:
            return _listing([])
        if "tmdb_id=300" in url:
            return _listing([{"id": 3, "tmdb_id": 300, "title": "C"}])
        if "/api/movies/3" in url:
            return _detail([_nom("Best Picture", "Someone Else", True)])
        raise AssertionError(f"unexpected OscarBase call: {url}")
    return get_json


class Cas984BackfillTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        self.cache_path = os.path.join(self._tmpdir.name, "oscarbase_cache.json")
        # CAS-906-style lesson: point the snapshot at a path never created here so these tests
        # stay snapshot-agnostic and never touch the real, git-tracked state/last_snapshot.json.
        self.snapshot_path = os.path.join(self._tmpdir.name, "last_snapshot.json")
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": [dict(m) for m in FIXTURE_MOVIES]}, fh)
        with open(self.cache_path, "w", encoding="utf-8") as fh:
            json.dump({"300": {"nominations": [], "fetched_at": "2026-01-01"}}, fh)

    def _read_catalogue(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            return {m["tmdb_id"]: m for m in json.load(fh)["movies"]}

    def test_only_uncached_titles_are_fetched_and_award_fields_land_on_the_catalogue(self):
        with mock.patch.object(pp, "get_json", side_effect=_get_json_for()), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            counts = backfill.run(catalogue_path=self.catalogue_path,
                                   cache_path=self.cache_path,
                                   snapshot_path=self.snapshot_path,
                                   budget=10)

        movies = self._read_catalogue()
        self.assertEqual(movies[100]["award"], "won")
        self.assertNotIn("award", movies[200])
        self.assertNotIn("award", movies[300])   # already cached, never queried
        self.assertEqual(counts["fetched"], 2)
        self.assertEqual(counts["remaining"], 0)

    def test_a_rerun_does_not_refetch_a_title_already_cached_with_a_resolved_answer(self):
        with mock.patch.object(pp, "get_json", side_effect=_get_json_for()), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                         snapshot_path=self.snapshot_path, budget=10)

        with mock.patch.object(pp, "get_json",
                               side_effect=AssertionError("must not re-fetch an already-cached "
                                                          "title")), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            counts = backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                                  snapshot_path=self.snapshot_path, budget=10)
        self.assertEqual(counts["fetched"], 0)
        self.assertEqual(counts["remaining"], 0)

    def test_the_budget_caps_titles_fetched_this_run(self):
        movies = [{"tmdb_id": i} for i in range(1, 6)]
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": movies}, fh)
        with open(self.cache_path, "w", encoding="utf-8") as fh:
            json.dump({}, fh)

        with mock.patch.object(pp, "get_json", return_value=_listing([])), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            counts = backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                                  snapshot_path=self.snapshot_path, budget=3)
        self.assertEqual(counts["fetched"], 3)
        self.assertEqual(counts["remaining"], 2)

    def test_prints_the_three_figures(self):
        out = io.StringIO()
        with mock.patch.object(pp, "get_json", side_effect=_get_json_for()), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0), \
             mock.patch("sys.stdout", out):
            backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                         snapshot_path=self.snapshot_path, budget=10)
        printed = out.getvalue()
        self.assertIn("fetched=", printed)
        self.assertIn("with_awards=", printed)
        self.assertIn("remaining=", printed)

    def test_with_awards_counts_cache_entries_carrying_nominations(self):
        with mock.patch.object(pp, "get_json", side_effect=_get_json_for()), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            counts = backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                                  snapshot_path=self.snapshot_path, budget=10)
        # 100 resolves with a nomination, 200 resolves empty, 300 was pre-seeded empty.
        self.assertEqual(counts["with_awards"], 1)


class Cas984SnapshotPersistenceTestCase(unittest.TestCase):
    """CAS-906's lesson, restated for OscarBase: award fields must survive the nightly rebuild
    from state/last_snapshot.json, or the next nightly run silently drops them the moment the
    title is cached (and so excluded from the nightly candidate list)."""

    CATALOGUE_MOVIES = [
        {"tmdb_id": 100, "title": "A"},
        {"tmdb_id": 300, "title": "C"},   # resolves with an award, absent from the snapshot
    ]
    SNAPSHOT_RECORDS = [
        {"tmdb_id": 100, "title": "A", "status": ["included_streaming"], "keep_me": "yes"},
        {"tmdb_id": 999, "title": "Unrelated", "status": ["in_cinema"], "keep_me": "too"},
    ]

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        self.cache_path = os.path.join(self._tmpdir.name, "oscarbase_cache.json")
        self.snapshot_path = os.path.join(self._tmpdir.name, "last_snapshot.json")
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": [dict(m) for m in self.CATALOGUE_MOVIES]}, fh)
        with open(self.cache_path, "w", encoding="utf-8") as fh:
            json.dump({}, fh)
        with open(self.snapshot_path, "w", encoding="utf-8") as fh:
            json.dump([dict(r) for r in self.SNAPSHOT_RECORDS], fh)

    def _run(self):
        with mock.patch.object(pp, "get_json", side_effect=_get_json_for()), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            return backfill.run(catalogue_path=self.catalogue_path, cache_path=self.cache_path,
                                snapshot_path=self.snapshot_path, budget=10)

    def _read_snapshot(self):
        with open(self.snapshot_path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_award_fields_land_in_both_files_with_the_same_values(self):
        counts = self._run()
        with open(self.catalogue_path, encoding="utf-8") as fh:
            movies = {m["tmdb_id"]: m for m in json.load(fh)["movies"]}
        snapshot_by_id = {r["tmdb_id"]: r for r in self._read_snapshot()}
        for field in backfill.OSCARBASE_FIELD_NAMES:
            self.assertEqual(movies[100][field], snapshot_by_id[100][field])
        self.assertEqual(counts["snapshot records updated"], 1)
        self.assertEqual(counts["snapshot records skipped (not in snapshot)"], 1)

    def test_a_title_absent_from_the_snapshot_is_skipped_not_appended(self):
        # 300 resolves with a real award but has no snapshot record at all — it must be counted
        # as skipped, never appended as a new snapshot entry.
        counts = self._run()
        snapshot_by_id = {r["tmdb_id"]: r for r in self._read_snapshot()}
        self.assertNotIn(300, snapshot_by_id)
        self.assertEqual(counts["snapshot records skipped (not in snapshot)"], 1)

    def test_the_snapshots_other_keys_and_record_order_are_unchanged(self):
        before_order = [r["tmdb_id"] for r in self.SNAPSHOT_RECORDS]
        self._run()
        after = self._read_snapshot()
        self.assertEqual([r["tmdb_id"] for r in after], before_order)
        unrelated = next(r for r in after if r["tmdb_id"] == 999)
        self.assertEqual(unrelated, {"tmdb_id": 999, "title": "Unrelated",
                                     "status": ["in_cinema"], "keep_me": "too"})
        matched = next(r for r in after if r["tmdb_id"] == 100)
        self.assertEqual(matched["title"], "A")
        self.assertEqual(matched["status"], ["included_streaming"])
        self.assertEqual(matched["keep_me"], "yes")


if __name__ == "__main__":
    unittest.main()
