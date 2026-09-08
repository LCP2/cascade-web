"""CAS-882 - the Watchmode re-probe answering Brian Einhaus's 8 Sep corrections.

Every network seam (`get`, `get_csv`) is monkeypatched before the probes run, so no test in
this file makes a live HTTP call. `CATALOGUE`/`OUT` are pointed at temp files so tests never
touch the real movies.json or write a stray report into the repo.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import cas882_watchmode_reprobe as wm  # noqa: E402

FIXTURE_MOVIES = [
    {"imdb_id": "tt0000001", "title": "A"},
    {"imdb_id": "tt0000002", "title": "B"},
    {"imdb_id": "tt0000003", "title": "C"},
]
FIXTURE_ID_MAP = {"9001": "tt0000001", "9002": "tt0000002", "9003": "tt0000003"}


class Cas882TestCase(unittest.TestCase):
    """Resets the module's mutable globals and points file paths at a temp dir per test."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.catalogue_path = os.path.join(self._tmpdir.name, "movies.json")
        self.report_path = os.path.join(self._tmpdir.name, "report.md")
        with open(self.catalogue_path, "w", encoding="utf-8") as fh:
            json.dump(FIXTURE_MOVIES, fh)

        self._orig = dict(
            KEY=wm.KEY, CATALOGUE=wm.CATALOGUE, OUT=wm.OUT, MAX_CREDITS=wm.MAX_CREDITS,
            get=wm.get, get_csv=wm.get_csv, spent=wm.spent, report=wm.report,
        )
        self.addCleanup(lambda: self._orig and wm.__dict__.update(self._orig))

        wm.KEY = "fake-real-secret-key"
        wm.CATALOGUE = self.catalogue_path
        wm.OUT = self.report_path
        wm.MAX_CREDITS = 120
        wm.spent = 0
        wm.report = []
        wm.get_csv = lambda url: (dict(FIXTURE_ID_MAP), None)

    def run_main(self):
        with self.assertRaises(SystemExit) as cm:
            wm.main()
        return cm.exception.code

    def read_report(self):
        with open(self.report_path, encoding="utf-8") as fh:
            return fh.read()


class ProbeARedaction(Cas882TestCase):
    def test_probe_a_urls_are_redacted_and_the_real_key_never_appears(self):
        def fake_get(path, params=None, cost=1):
            if path.startswith("/title/"):
                return {"title": "stub", "content_ratings": {"AU": "M"}}, 200, None
            return {}, 200, None
        wm.get = fake_get

        code = self.run_main()
        self.assertEqual(code, 0)
        text = self.read_report()
        for wm_id, _title, _expected in wm.PROBE_A_TITLES:
            self.assertIn(f"/title/{wm_id}/details/", text)
        self.assertIn("REDACTED", text)
        self.assertNotIn(wm.KEY, text)


class ProbeBStats(Cas882TestCase):
    def test_probe_b_reports_distinct_counts_and_treats_missing_relevance_as_absent(self):
        def fake_get(path, params=None, cost=1):
            if path.startswith("/title/"):
                # relevance_percentile deliberately missing on this stub - popularity_percentile present.
                return {"popularity_percentile": 42}, 200, None
            return {}, 200, None
        wm.get = fake_get

        code = self.run_main()
        self.assertEqual(code, 0)
        text = self.read_report()
        self.assertIn("relevance_percentile", text)
        self.assertIn("popularity_percentile", text)
        self.assertIn("distinct values", text)
        self.assertIn("present on **0 / 3**", text)  # relevance_percentile: absent on every stub


class ProbeCFailure(Cas882TestCase):
    def test_probe_c_non_200_is_a_reported_line_not_an_exception(self):
        def fake_get(path, params=None, cost=1):
            if path == "/changes/titles_details_changed/":
                return None, 400, "HTTP 400: Invalid method"
            if path == "/changes/titles_sources_changed/":
                return {"changes": [{"id": 1}], "total_pages": 1}, 200, None
            return {}, 200, None
        wm.get = fake_get

        code = self.run_main()  # must not raise - a dead endpoint cannot kill the run
        self.assertEqual(code, 0)
        text = self.read_report()
        self.assertIn("titles_details_changed", text)
        self.assertIn("FAILED", text)
        self.assertIn("titles_sources_changed", text)
        self.assertIn("total_pages", text)


class MissingKey(Cas882TestCase):
    def test_no_key_exits_nonzero_and_writes_no_report(self):
        wm.KEY = None
        code = self.run_main()
        self.assertNotEqual(code, 0)
        self.assertFalse(os.path.exists(self.report_path))


if __name__ == "__main__":
    unittest.main()
