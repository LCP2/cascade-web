"""CAS-850 - the Watchmode fields backfill script (scripts/cas850_watchmode_backfill.py).

Every network seam is monkeypatched on poc_pipeline directly (the script imports that module),
so no test here makes a live HTTP call. The catalogue path is a temp file per test, so tests
never touch the real movies.json.
"""
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
        # Not CACHED_REASON: FIXTURE_MOVIES' third title has no Watchmode id at all, so this
        # rerun is a mix of cached + no-id, not "every candidate cached" — still a legitimate
        # no-op, but AC3 only names the pure-cache case, so it still exits non-zero (below).
        self.assertNotEqual(counts["early exit reason"], backfill.CACHED_REASON)
        self.assertEqual(backfill._exit_code_for(counts), 1)

    def test_candidate_records_considered_is_reported(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10)
        self.assertEqual(counts["candidate records considered"], len(FIXTURE_MOVIES))
        self.assertEqual(counts["records written"], 2)

    def test_reason_names_the_cause_when_the_idmap_fetch_returns_nothing_usable(self):
        """CAS-862: this is the actual pre-fix defect — a live idmap response whose column names
        `_parse_watchmode_idmap_csv` didn't recognise resolved to an empty map, so every title
        read as 'no id' and the run exited 0 having written nothing."""
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={}), \
             mock.patch.object(pp, "_fetch_watchmode_title_details",
                               side_effect=AssertionError("no id map means no per-title calls")):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10)

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
                                   ids_from=self.ids_path)

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
                                   ids_from=self.ids_path)

        self.assertEqual(counts["ids requested"], 2)
        self.assertEqual(counts["ids not found in catalogue"], 1)
        self.assertEqual(counts["titles enriched"], 1)

    def test_omitting_the_argument_leaves_full_catalogue_behaviour_unchanged(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value=dict(FIXTURE_IDMAP)), \
             mock.patch.object(pp, "_fetch_watchmode_title_details", return_value=dict(FIXTURE_DETAIL)):
            counts = backfill.run(catalogue_path=self.catalogue_path, max_credits=10)

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
