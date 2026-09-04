"""CAS-767 - the paid-plan Watchmode trial harness.

Every network seam (`get`, `get_csv`) is monkeypatched before `main()` runs, so no test in this
file makes a live HTTP call. `CATALOGUE`/`OUT` are pointed at temp files so tests never touch the
real movies.json or write a stray report into the repo.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import cas767_watchmode_trial_eval as wm  # noqa: E402

FIXTURE_MOVIES = [
    {"imdb_id": "tt0000001", "title": "A", "popularity": 90, "cinema_date": "2026-07-16",
     "age_rating": "M", "imdb_rating": 8.1, "award": "won"},
    {"imdb_id": "tt0000002", "title": "B", "popularity": 50, "cinema_date": "2026-06-01",
     "age_rating": None, "imdb_rating": 6.4, "award": None},
    {"imdb_id": "tt0000003", "title": "C", "popularity": 10, "cinema_date": None,
     "age_rating": "MA15+", "imdb_rating": 7.2, "award": "nominated"},
]


class Cas767TestCase(unittest.TestCase):
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

        wm.KEY = "fake-trial-key"
        wm.CATALOGUE = self.catalogue_path
        wm.OUT = self.report_path
        wm.MAX_CREDITS = 2000
        wm.spent = 0
        wm.report = []
        wm.get_csv = lambda url: ({}, None)

    def run_main(self):
        with self.assertRaises(SystemExit) as cm:
            wm.main()
        return cm.exception.code

    def read_report(self):
        with open(self.report_path, encoding="utf-8") as fh:
            return fh.read()


class MissingKey(Cas767TestCase):
    def test_no_key_exits_nonzero_and_writes_no_report(self):
        wm.KEY = None
        code = self.run_main()
        self.assertNotEqual(code, 0)
        self.assertFalse(os.path.exists(self.report_path))


class TrialNotActive(Cas767TestCase):
    def test_401_on_release_dates_produces_explicit_trial_not_active_line(self):
        def fake_get(path, params=None, cost=1):
            if path == "/title-release-dates/":
                return None, "HTTP 401: no access to this endpoint on your current plan"
            return [], None
        wm.get = fake_get
        code = self.run_main()
        self.assertNotEqual(code, 0)
        text = self.read_report().lower()
        self.assertIn("401", text)
        self.assertIn("trial is not active", text)


class CreditGuard(Cas767TestCase):
    def test_credit_guard_stops_further_spend_once_the_cap_is_reached(self):
        wm.MAX_CREDITS = 1  # the mandatory trial-status probe alone reaches this
        calls = []

        def fake_get(path, params=None, cost=1):
            calls.append(path)
            wm.spent += cost
            if path == "/title-release-dates/":
                return [], None
            return {}, None
        wm.get = fake_get
        code = self.run_main()
        self.assertEqual(code, 0)
        # Only the one mandatory probe call should have run - every per-title detail call and
        # the changes-endpoint call must have been skipped once spent reached the cap.
        self.assertEqual(calls, ["/title-release-dates/"])
        text = self.read_report().lower()
        self.assertIn("credit cap", text)


class EmptyFieldStub(Cas767TestCase):
    def test_each_of_the_six_sections_renders_not_carried_on_an_empty_stub(self):
        # A well-formed but content-free stub: valid JSON shapes, every list empty, no
        # watchmode-id resolution (setUp's get_csv stub already returns {}) - so no per-title
        # detail call is even issued. Every section must still explain itself, not go silent.
        def fake_get(path, params=None, cost=1):
            if path == "/title-release-dates/":
                return [], None
            if path == "/changes/":
                return [], None
            return {}, None
        wm.get = fake_get

        code = self.run_main()
        self.assertEqual(code, 0)
        report = self.read_report()
        sections = report.split("## ")[1:]
        self.assertEqual(len(sections), 6, "expected all six sections to render")
        for section in sections:
            self.assertIn("not carried", section.lower(), msg=f"section missing not-carried: {section[:60]!r}")


if __name__ == "__main__":
    unittest.main()
