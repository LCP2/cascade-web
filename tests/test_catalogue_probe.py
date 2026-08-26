"""CAS-607 — the TMDB probe's verdict logic: does poc_pipeline's ingest see a given title, and by
which pass (theatrical / upcoming / streaming), or none at all?

verdict() takes an anchor `today` explicitly (never datetime.date.today()) so every case below is
reproducible and needs no network — it is the same pure function scripts/catalogue_sizing.py's
--probe mode calls after making its (mocked-here, real-in-production) TMDB requests.
"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import catalogue_sizing as cs  # noqa: E402
from poc_pipeline import LOOKBACK_DAYS, UPCOMING_LOOKAHEAD_DAYS  # noqa: E402

TODAY = datetime.date(2026, 6, 15)


class VerdictLogic(unittest.TestCase):
    def test_au_theatrical_date_in_lookback_window_is_theatrical_pass(self):
        in_window = (TODAY - datetime.timedelta(days=LOOKBACK_DAYS // 2)).isoformat()
        result = cs.verdict([(3, in_window)], has_au_provider=False, today=TODAY)
        self.assertIn("theatrical pass", result)

    def test_au_theatrical_date_in_the_future_is_upcoming_pass(self):
        upcoming = (TODAY + datetime.timedelta(days=UPCOMING_LOOKAHEAD_DAYS // 2)).isoformat()
        result = cs.verdict([(2, upcoming)], has_au_provider=False, today=TODAY)
        self.assertIn("upcoming pass", result)

    def test_no_au_dates_but_an_au_provider_row_is_streaming_pass(self):
        result = cs.verdict([], has_au_provider=True, today=TODAY)
        self.assertIn("streaming pass", result)

    def test_neither_dates_nor_provider_is_none(self):
        result = cs.verdict([], has_au_provider=False, today=TODAY)
        self.assertIn("none", result)

    def test_a_date_outside_both_windows_with_no_provider_is_still_none(self):
        too_old = (TODAY - datetime.timedelta(days=LOOKBACK_DAYS + 30)).isoformat()
        result = cs.verdict([(3, too_old)], has_au_provider=False, today=TODAY)
        self.assertIn("none", result)

    def test_non_theatrical_release_type_does_not_count_as_theatrical(self):
        # type 1 = premiere, not the 2|3 (limited/theatrical) the ingest passes require.
        in_window = (TODAY - datetime.timedelta(days=1)).isoformat()
        result = cs.verdict([(1, in_window)], has_au_provider=False, today=TODAY)
        self.assertIn("none", result)


class ProbeModeIsNonDestructive(unittest.TestCase):
    def test_missing_tmdb_key_exits_non_zero_and_never_writes_the_doc_file(self):
        old_key = cs.TMDB_KEY
        cs.TMDB_KEY = None
        try:
            self.assertTrue(os.path.exists(os.path.dirname(cs.DOC_FILE)) or True)
            before = os.path.exists(cs.DOC_FILE)
            before_mtime = os.path.getmtime(cs.DOC_FILE) if before else None
            exit_code = cs.probe_title("Whatever")
            self.assertNotEqual(exit_code, 0)
            after = os.path.exists(cs.DOC_FILE)
            self.assertEqual(before, after)
            if before:
                self.assertEqual(before_mtime, os.path.getmtime(cs.DOC_FILE))
        finally:
            cs.TMDB_KEY = old_key


if __name__ == "__main__":
    unittest.main()
