"""CAS-850 - the Watchmode fields backfill script (scripts/cas850_watchmode_backfill.py).

Every network seam is monkeypatched on poc_pipeline directly (the script imports that module),
so no test here makes a live HTTP call. The catalogue path is a temp file per test, so tests
never touch the real movies.json.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
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
        # CAS-906: `run()` now also writes a snapshot. Point it at a path inside the tmp dir that
        # is never created here — `load_snapshot` reads that as "no snapshot", so these
        # pre-CAS-906 tests stay snapshot-agnostic and (critically) never touch the real,
        # 11MB, git-tracked state/last_snapshot.json that `run()` defaults to.
        self.snapshot_path = os.path.join(self._tmpdir.name, "last_snapshot.json")

    def _write_catalogue(self, movies):
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": movies}, fh)

    def _read_catalogue(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            return json.load(fh)["movies"]

    def test_resolved_titles_are_enriched_and_the_unresolved_title_is_left_untouched(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)

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
            backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)
        printed = out.getvalue()
        for label in ("titles enriched", "titles skipped for budget",
                      "titles with no Watchmode id", "credits spent"):
            self.assertIn(label, printed)

    def test_a_rerun_immediately_after_a_successful_pass_is_a_no_op(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)

            with mock.patch.object(pp, "_fetch_watchmode_title_details",
                                   side_effect=AssertionError("must not re-fetch a fresh record")):
                counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)

        self.assertEqual(counts["titles enriched"], 0)
        self.assertEqual(counts["credits spent"], 0)
        # Not CACHED_REASON: FIXTURE_MOVIES' third title has no Watchmode id at all, so this
        # rerun is a mix of cached + no-id, not "every candidate cached" — still a legitimate
        # no-op, but AC3 only names the pure-cache case, so it still exits non-zero (below).
        self.assertNotEqual(counts["early exit reason"], backfill.CACHED_REASON)
        self.assertEqual(backfill._exit_code_for(counts), 1)

    def test_candidate_records_considered_is_reported(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)
        self.assertEqual(counts["candidate records considered"], len(FIXTURE_MOVIES))
        self.assertEqual(counts["records written"], 2)

    def test_reason_names_the_cause_when_the_idmap_fetch_returns_nothing_usable(self):
        """CAS-862: this is the actual pre-fix defect — a live idmap response whose column names
        `_parse_watchmode_idmap_csv` didn't recognise resolved to an empty map, so every title
        read as 'no id' and the run exited 0 having written nothing."""
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={}), \
             mock.patch.object(pp, "_fetch_watchmode_title_details",
                               side_effect=AssertionError("no id map means no per-title calls")):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)

        self.assertEqual(counts["titles enriched"], 0)
        self.assertEqual(counts["early exit reason"],
                          "the Watchmode ID map fetch returned no usable rows")


class Cas889IdsFromTestCase(unittest.TestCase):
    """CAS-889: `--ids-from` restricts a run to a caller-supplied id list instead of walking the
    whole catalogue."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": [dict(m) for m in FIXTURE_MOVIES]}, fh)
        self.ids_path = os.path.join(self._tmpdir.name, "ids.txt")
        # CAS-906: see Cas850BackfillTestCase.setUp — keeps run() off the real snapshot file.
        self.snapshot_path = os.path.join(self._tmpdir.name, "last_snapshot.json")

    def _read_catalogue(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            return {m["tmdb_id"]: m for m in json.load(fh)["movies"]}

    def _write_ids(self, lines):
        with open(self.ids_path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")

    def test_only_the_listed_ids_receive_a_details_call(self):
        # 100 is listed and resolves via the idmap; 200 is a real catalogue id left OUT of the
        # list, so it must not be touched even though the idmap could resolve it too.
        self._write_ids(["# comment", "", "100"])
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   ids_from=self.ids_path, snapshot_path=self.snapshot_path)

        by_id = self._read_catalogue()
        self.assertEqual(by_id[100]["wm_user_rating"], 7.5)
        self.assertNotIn("wm_user_rating", by_id[200])
        self.assertNotIn("wm_user_rating", by_id[300])
        self.assertEqual(counts["candidate records considered"], 1)
        self.assertEqual(counts["titles enriched"], 1)

    def test_an_id_absent_from_the_catalogue_is_reported_and_skipped_not_raised(self):
        self._write_ids(["100", "999999"])
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   ids_from=self.ids_path, snapshot_path=self.snapshot_path)

        self.assertEqual(counts["ids requested"], 2)
        self.assertEqual(counts["ids not found in catalogue"], 1)
        self.assertEqual(counts["titles enriched"], 1)

    def test_omitting_the_argument_leaves_full_catalogue_behaviour_unchanged(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                   snapshot_path=self.snapshot_path)

        self.assertNotIn("ids requested", counts)
        self.assertEqual(counts["candidate records considered"], len(FIXTURE_MOVIES))
        self.assertEqual(counts["titles enriched"], 2)


class ExitCodeForTestCase(unittest.TestCase):
    """CAS-862 AC3 — a green (exit 0) run that resolves 0 titles is only legitimate when every
    candidate was already fresh; any other zero must exit non-zero."""

    def test_exit_code_is_zero_when_everything_is_freshly_cached(self):
        counts = {"titles enriched": 0, "early exit reason": backfill.CACHED_REASON}
        self.assertEqual(backfill._exit_code_for(counts), 0)

    def test_exit_code_is_nonzero_when_zero_titles_resolve_for_another_reason(self):
        counts = {"titles enriched": 0,
                   "early exit reason": "the Watchmode ID map fetch returned no usable rows"}
        self.assertEqual(backfill._exit_code_for(counts), 1)

    def test_exit_code_is_zero_when_titles_are_enriched(self):
        counts = {"titles enriched": 3, "early exit reason": None}
        self.assertEqual(backfill._exit_code_for(counts), 0)


class Cas906SnapshotPersistenceTestCase(unittest.TestCase):
    """CAS-906: the backfill's writes must survive the nightly run, which rebuilds the whole
    catalogue from state/last_snapshot.json, never from movies.json. So the backfill's wm_*
    writes must land in BOTH files, merged onto the snapshot's existing record, never appended
    for a title the snapshot doesn't have."""

    CATALOGUE_MOVIES = [
        {"tmdb_id": 100, "title": "A"},   # resolves via idmap, present in the snapshot
        {"tmdb_id": 200, "title": "B"},   # resolves via idmap, present in the snapshot
        {"tmdb_id": 300, "title": "C"},   # resolves via idmap, ABSENT from the snapshot
    ]
    SNAPSHOT_RECORDS = [
        {"tmdb_id": 100, "title": "A", "status": ["included_streaming"], "keep_me": "yes"},
        {"tmdb_id": 200, "title": "B", "status": ["upcoming"], "keep_me": "also"},
        # unrelated to movies.json entirely — must survive completely untouched.
        {"tmdb_id": 999, "title": "Unrelated", "status": ["in_cinema"], "keep_me": "too"},
    ]
    IDMAP = {"wm100": 100, "wm200": 200, "wm300": 300}
    DETAIL = {"user_rating": 7.5, "critic_score": 60, "popularity_percentile": 80.0}

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        self.snapshot_path = os.path.join(self._tmpdir.name, "last_snapshot.json")
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump({"movies": [dict(m) for m in self.CATALOGUE_MOVIES]}, fh)
        with open(self.snapshot_path, "w", encoding="utf-8") as fh:
            json.dump([dict(r) for r in self.SNAPSHOT_RECORDS], fh)

    def _run(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(self.IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(self.DETAIL)):
            return backfill.run(catalogue_path=self.catalogue_path, max_credits=10,
                                 snapshot_path=self.snapshot_path)

    def _read_catalogue(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            return {m["tmdb_id"]: m for m in json.load(fh)["movies"]}

    def _read_snapshot(self):
        with open(self.snapshot_path, encoding="utf-8") as fh:
            return json.load(fh)

    def test_wm_fields_land_in_both_files_with_the_same_values(self):
        counts = self._run()
        movies = self._read_catalogue()
        snapshot_by_id = {r["tmdb_id"]: r for r in self._read_snapshot()}
        for tmdb_id in (100, 200):
            for field in backfill.WM_FIELD_NAMES:
                self.assertEqual(movies[tmdb_id][field], snapshot_by_id[tmdb_id][field])
        self.assertEqual(counts["snapshot records updated"], 2)

    def test_a_title_absent_from_the_snapshot_is_skipped_not_appended(self):
        counts = self._run()
        snapshot_by_id = {r["tmdb_id"]: r for r in self._read_snapshot()}
        self.assertNotIn(300, snapshot_by_id)
        self.assertEqual(counts["snapshot records skipped (not in snapshot)"], 1)

    def test_the_snapshots_other_keys_and_record_order_are_unchanged(self):
        before_order = [r["tmdb_id"] for r in self.SNAPSHOT_RECORDS]
        self._run()
        after = self._read_snapshot()
        self.assertEqual([r["tmdb_id"] for r in after], before_order)
        # the unrelated record (999, never in movies.json) must come back byte-for-byte.
        unrelated = next(r for r in after if r["tmdb_id"] == 999)
        self.assertEqual(unrelated, {"tmdb_id": 999, "title": "Unrelated",
                                     "status": ["in_cinema"], "keep_me": "too"})
        # matched records keep their pre-existing keys alongside the new wm_* ones.
        matched = next(r for r in after if r["tmdb_id"] == 100)
        self.assertEqual(matched["title"], "A")
        self.assertEqual(matched["status"], ["included_streaming"])
        self.assertEqual(matched["keep_me"], "yes")

    def test_when_the_snapshot_write_raises_movies_json_is_left_unmodified(self):
        with open(self.catalogue_path, encoding="utf-8") as fh:
            original_catalogue = fh.read()
        with mock.patch.object(backfill, "save_snapshot",
                               side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self._run()
        with open(self.catalogue_path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), original_catalogue)

    def test_the_regression_the_ticket_names_wm_fields_survive_a_catalogue_rebuild(self):
        """The actual defect: `poc_pipeline.run()` rebuilds the WHOLE catalogue from
        state/last_snapshot.json (poc_pipeline.py:1595), via build_live_catalogue. Prove the
        fix by running that same rebuild path over the snapshot this backfill just wrote, and
        asserting the wm_* fields are still on the rebuilt record — not just present in the
        snapshot file in isolation."""
        self._run()
        base_records = self._read_snapshot()
        for record in base_records:
            record.setdefault("imdb_id", f"tt{record['tmdb_id']:07d}")
            record.setdefault("cinema_date", "2025-01-01")
            record.setdefault("popularity", 10.0)
            record.setdefault("imdb_rating", 7.4)
            record.setdefault("imdb_votes", 50_000)
            record.setdefault("offers", [{"service": "Netflix", "type": "sub",
                                          "price": None, "format": "HD"}])
            record.setdefault("availability_confidence", "confirmed")
            record.setdefault("availability_source", "tmdb_providers")
            record.setdefault("last_polled", "2026-07-23")

        prov = {"jw_link": "https://jw/x", "rows": {"flatrate": [{"provider_name": "Netflix"}]}}
        patches = [
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "tmdb_providers", lambda tid: prov),
            mock.patch.object(pp, "has_provider_rows", lambda p: True),
            mock.patch.object(pp, "provider_offers", lambda p: [{"service": "Netflix", "type": "sub",
                                                                "price": None, "format": "HD"}]),
            mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

        today = datetime.date(2026, 7, 24)
        catalogue, _counts = pp.build_live_catalogue(today, base_records, {}, ondemand_ids=[])

        rebuilt = {m["tmdb_id"]: m for m in catalogue}
        for tmdb_id in (100, 200):
            self.assertEqual(rebuilt[tmdb_id]["wm_user_rating"], 7.5)
            self.assertEqual(rebuilt[tmdb_id]["wm_critic_score"], 60)
            self.assertEqual(rebuilt[tmdb_id]["wm_popularity_percentile"], 80.0)
            self.assertEqual(rebuilt[tmdb_id]["wm_fields_fetched_at"], pp._RUN_DATE)


class Cas859SubprocessInvocationTestCase(unittest.TestCase):
    """CAS-859: the workflow runs this script as a subprocess from the repo root, not as an
    in-process import — pytest's own import (above) puts the repo root on sys.path for free and
    so cannot catch the ModuleNotFoundError the real invocation hit."""

    def _run_without_api_key(self):
        env = dict(os.environ)
        env.pop("WATCHMODE_API_KEY", None)
        return subprocess.run(
            [sys.executable, os.path.join("scripts", "cas850_watchmode_backfill.py")],
            cwd=_REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_the_script_imports_cleanly_when_run_as_a_subprocess_from_the_repo_root(self):
        result = self._run_without_api_key()
        self.assertNotIn("ModuleNotFoundError", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_a_missing_api_key_exits_cleanly_with_a_message_instead_of_a_traceback(self):
        result = self._run_without_api_key()
        self.assertEqual(result.returncode, 0)
        self.assertIn("WATCHMODE_API_KEY", result.stdout)


if __name__ == "__main__":
    unittest.main()
