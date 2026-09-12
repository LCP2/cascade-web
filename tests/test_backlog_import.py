"""CAS-525 — on-demand historical backlog import, gated by rating threshold and release-date range.

CAS-938: OMDb, the rating source `run_backlog_import` scored candidates against, is retired from
the pipeline — see backlog_import.py's module docstring. `run_backlog_import` now refuses to run
(no candidates discovered, nothing written) pending a redesign onto a Watchmode-backed rating
source. The pure helper functions it used to call (date resolution, the OR-across-thresholds gate)
are unaffected and still covered below, since a redesign will still need them.

Every test here mocks the network and redirects file IO to a temp dir. Nothing reaches TMDB, and
the real state/last_snapshot.json is never touched.
"""
import os
import unittest
from unittest import mock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import backlog_import as bi
import poc_pipeline as pp


def _detail(tmdb_id=1, title="Test Film", release_date="2016-06-01", release_dates_au=None, **kw):
    d = {"id": tmdb_id, "imdb_id": f"tt{tmdb_id:07d}", "title": title, "release_date": release_date,
         "genres": [], "production_countries": [], "original_language": "en",
         "release_dates": {"results": [{"iso_3166_1": "AU", "release_dates": release_dates_au or []}]},
         "videos": {"results": []}, "credits": {"cast": [], "crew": []}}
    d.update(kw)
    return d


class ParseArgsRequiresAtLeastOneThreshold(unittest.TestCase):
    def test_no_threshold_is_rejected(self):
        with self.assertRaises(SystemExit):
            bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31"])

    def test_one_threshold_is_accepted(self):
        args = bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31", "--min-imdb", "6.5"])
        self.assertEqual(args.min_imdb, 6.5)
        self.assertIsNone(args.min_rt)

    def test_start_after_end_is_rejected(self):
        with self.assertRaises(SystemExit):
            bi.parse_args(["--start", "2018-01-01", "--end", "2015-01-01", "--min-imdb", "6.5"])

    def test_bad_date_format_is_rejected(self):
        with self.assertRaises(SystemExit):
            bi.parse_args(["--start", "01/01/2015", "--end", "2018-12-31", "--min-imdb", "6.5"])


class ThresholdsFromArgsOnlyIncludesWhatWasSet(unittest.TestCase):
    def test_only_imdb_set(self):
        args = bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31", "--min-imdb", "5"])
        self.assertEqual(bi.thresholds_from_args(args), {"imdb_rating": 5.0})

    def test_all_three_set(self):
        args = bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31",
                              "--min-imdb", "5", "--min-rt", "60", "--min-meta", "50"])
        self.assertEqual(bi.thresholds_from_args(args),
                         {"imdb_rating": 5.0, "rt_critic": 60, "metacritic": 50})


class ResolveEffectiveDate(unittest.TestCase):
    """CAS-525 req 4: cinema titles use cinema_date; non-cinema titles use the AU digital (type=4)
    date; failing that, TMDB's global release_date, flagged as a fallback."""

    def test_a_cinema_release_uses_cinema_date(self):
        record = pp._tmdb_record(_detail(release_dates_au=[
            {"type": 3, "release_date": "2016-03-01T00:00:00.000Z", "certification": "M"}]))
        date, source = bi.resolve_effective_date(record, "2016-01-01")
        self.assertEqual((date, source), ("2016-03-01", "cinema"))

    def test_a_type_2_limited_release_is_not_treated_as_cinema(self):
        """cinema_release is only true for type 3 — type 2 alone must fall through to AU digital
        or the global fallback, not be treated as a confirmed cinema date."""
        record = pp._tmdb_record(_detail(release_dates_au=[
            {"type": 2, "release_date": "2016-03-01T00:00:00.000Z", "certification": ""},
            {"type": 4, "release_date": "2016-07-01T00:00:00.000Z", "certification": ""}]))
        date, source = bi.resolve_effective_date(record, "2016-01-01")
        self.assertEqual((date, source), ("2016-07-01", "au_digital"))

    def test_no_cinema_release_uses_au_digital_date(self):
        record = pp._tmdb_record(_detail(release_dates_au=[
            {"type": 4, "release_date": "2016-08-15T00:00:00.000Z", "certification": ""}]))
        date, source = bi.resolve_effective_date(record, "2016-01-01")
        self.assertEqual((date, source), ("2016-08-15", "au_digital"))

    def test_no_au_dates_at_all_falls_back_to_tmdb_global_release_date(self):
        record = pp._tmdb_record(_detail(release_dates_au=[]))
        date, source = bi.resolve_effective_date(record, "2016-01-01")
        self.assertEqual((date, source), ("2016-01-01", "fallback_global"))

    def test_no_dates_anywhere_returns_none(self):
        record = pp._tmdb_record(_detail(release_dates_au=[]))
        date, source = bi.resolve_effective_date(record, None)
        self.assertEqual((date, source), (None, "fallback_global"))


class InRange(unittest.TestCase):
    def test_within_bounds(self):
        self.assertTrue(bi.in_range("2016-06-01", "2015-01-01", "2018-12-31"))

    def test_on_the_boundary_is_inclusive(self):
        self.assertTrue(bi.in_range("2015-01-01", "2015-01-01", "2018-12-31"))
        self.assertTrue(bi.in_range("2018-12-31", "2015-01-01", "2018-12-31"))

    def test_outside_bounds(self):
        self.assertFalse(bi.in_range("2019-01-01", "2015-01-01", "2018-12-31"))

    def test_none_is_never_in_range(self):
        self.assertFalse(bi.in_range(None, "2015-01-01", "2018-12-31"))


class RatingGate(unittest.TestCase):
    """CAS-525 req 2: no score on any of the three -> excluded. req 1: OR across whichever
    threshold(s) are actually set."""

    def test_no_scores_at_all_has_no_score(self):
        self.assertFalse(bi.has_any_score({}))

    def test_any_one_score_present_counts(self):
        self.assertTrue(bi.has_any_score({"rt_critic": 80}))

    def test_clears_the_only_threshold_set(self):
        self.assertTrue(bi.passes_rating_gate({"imdb_rating": 7.0}, {"imdb_rating": 5.0}))

    def test_fails_the_only_threshold_set(self):
        self.assertFalse(bi.passes_rating_gate({"imdb_rating": 4.0}, {"imdb_rating": 5.0}))

    def test_an_unset_source_never_gates_even_if_present(self):
        """min_imdb=5 only: an RT score existing but not clearing some unset RT bar must not fail
        the title, and must not count as a pass either — imdb alone decides."""
        record = {"imdb_rating": 7.0, "rt_critic": 10}
        self.assertTrue(bi.passes_rating_gate(record, {"imdb_rating": 5.0}))

    def test_ok_on_any_one_of_several_set_thresholds(self):
        record = {"imdb_rating": None, "rt_critic": 85, "metacritic": None}
        thresholds = {"imdb_rating": 6.0, "rt_critic": 60, "metacritic": 60}
        self.assertTrue(bi.passes_rating_gate(record, thresholds))

    def test_a_missing_score_for_a_set_threshold_does_not_pass_on_its_own(self):
        record = {"imdb_rating": None, "rt_critic": 40, "metacritic": None}
        thresholds = {"imdb_rating": 6.0, "rt_critic": 60}
        self.assertFalse(bi.passes_rating_gate(record, thresholds))


class RunBacklogImportRefusesToRunWithNoRatingSource(unittest.TestCase):
    """CAS-938: OMDb is gone, so the rating gate has nothing to score candidates against.
    `run_backlog_import` must refuse to run rather than silently import nothing while claiming
    to have looked — in particular it must never call `discover_candidates` (which would burn
    real TMDB calls for a foregone conclusion)."""

    def test_missing_key_makes_no_network_calls_and_writes_nothing(self):
        args = bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31", "--min-imdb", "5"])
        with mock.patch.object(pp, "TMDB_KEY", None), \
             mock.patch.object(bi, "discover_candidates",
                               side_effect=AssertionError("must not discover without a key")):
            counts = bi.run_backlog_import(args)
        self.assertEqual(counts["imported"], 0)

    def test_a_present_key_still_refuses_since_the_rating_source_is_gone(self):
        args = bi.parse_args(["--start", "2015-01-01", "--end", "2018-12-31", "--min-imdb", "5"])
        with mock.patch.object(pp, "TMDB_KEY", "tmdb-test-key"), \
             mock.patch.object(bi, "discover_candidates",
                               side_effect=AssertionError("must not discover — no rating source")):
            counts = bi.run_backlog_import(args)
        self.assertEqual(counts["imported"], 0)
        self.assertEqual(counts["candidates"], 0)


if __name__ == "__main__":
    unittest.main()
