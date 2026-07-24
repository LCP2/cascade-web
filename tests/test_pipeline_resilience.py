"""CAS-161 — one bad API answer must not cost the whole day's refresh.

The defect these cover: `enrich_omdb` called `get_json` with no guard, so a single OMDb hiccup — a 401 when
the free tier's daily cap is hit, a transient 5xx that outlived its retries, one unknown title — raised
straight out of `build_live_catalogue` and killed the run. Nothing was committed for that day.

Every test here mocks the network. Nothing reaches OMDb, TMDB or Watchmode, and no file is written.
"""
import datetime
import io
import unittest
import urllib.error
from unittest import mock

import poc_pipeline as pp


def _http_error(code, body=b""):
    return urllib.error.HTTPError("https://www.omdbapi.com/", code, "err", {}, io.BytesIO(body))


def _title(tmdb_id=1, **kw):
    """A released title carrying yesterday's good data — the thing a failed enrich must not damage."""
    m = {"tmdb_id": tmdb_id, "imdb_id": f"tt{tmdb_id:07d}", "title": f"Film {tmdb_id}",
         "cinema_date": "2025-01-01", "popularity": 10.0,
         "imdb_rating": 7.4, "imdb_votes": 50_000, "rt_critic": 88,
         "offers": [{"service": "Netflix", "type": "sub", "price": None, "format": "HD"}],
         "status": ["included_streaming"], "availability_confidence": "confirmed",
         "availability_source": "tmdb_providers", "last_polled": "2026-07-23"}
    m.update(kw)
    return m


class ApiCallOutcomes(unittest.TestCase):
    """_api_call is the whole safety net: it decides skip-this-title vs stop-asking-this-API."""

    def test_success_passes_the_value_through(self):
        self.assertEqual(pp._api_call("OMDb", lambda: {"ok": 1}), ({"ok": 1}, "ok"))

    def test_401_stops_the_api_for_the_rest_of_the_run(self):
        # The daily cap is not a property of one title, so retrying it ~1,900 more times is pure waste.
        def boom():
            raise _http_error(401, b'{"Response":"False","Error":"Request limit reached!"}')
        self.assertEqual(pp._api_call("OMDb", boom)[1], "stop")

    def test_403_also_stops(self):
        def boom():
            raise _http_error(403)
        self.assertEqual(pp._api_call("OMDb", boom)[1], "stop")

    def test_transient_5xx_skips_only_this_title(self):
        def boom():
            raise _http_error(503)
        self.assertEqual(pp._api_call("OMDb", boom)[1], "skip")

    def test_404_skips_only_this_title(self):
        def boom():
            raise _http_error(404)
        self.assertEqual(pp._api_call("OMDb", boom)[1], "skip")

    def test_non_http_errors_skip_rather_than_raise(self):
        def boom():
            raise TimeoutError("read timed out")
        self.assertEqual(pp._api_call("Watchmode", boom)[1], "skip")

    def test_limit_wording_stops_even_without_an_http_code(self):
        # OMDb reports the cap as HTTP 200 + Response:"False" as often as it does 401.
        def boom():
            raise pp.ApiDeclined("Request limit reached!")
        self.assertEqual(pp._api_call("OMDb", boom)[1], "stop")

    def test_a_declined_unknown_title_is_only_a_skip(self):
        def boom():
            raise pp.ApiDeclined("Incorrect IMDb ID.")
        self.assertEqual(pp._api_call("OMDb", boom)[1], "skip")


class EnrichOmdbLeavesGoodDataAlone(unittest.TestCase):
    def test_soft_failure_raises_before_touching_the_record(self):
        """HTTP 200 + Response:"False" makes every getter return None. Writing those over a stored
        rating would be a silent data regression, so the record must come back untouched."""
        m = _title()
        with mock.patch.object(pp, "get_json",
                               return_value={"Response": "False", "Error": "Request limit reached!"}):
            with self.assertRaises(pp.ApiDeclined):
                pp.enrich_omdb(m)
        self.assertEqual(m["imdb_rating"], 7.4)
        self.assertEqual(m["imdb_votes"], 50_000)
        self.assertEqual(m["rt_critic"], 88)

    def test_a_good_response_still_enriches(self):
        m = _title(imdb_rating=None, imdb_votes=None)
        payload = {"Response": "True", "imdbRating": "8.1", "imdbVotes": "1,234",
                   "Ratings": [{"Source": "Rotten Tomatoes", "Value": "91%"},
                               {"Source": "Metacritic", "Value": "77/100"}],
                   "Awards": "Won 2 Oscars. 5 wins & 9 nominations."}
        with mock.patch.object(pp, "get_json", return_value=payload):
            pp.enrich_omdb(m)
        self.assertEqual(m["imdb_rating"], 8.1)
        self.assertEqual(m["imdb_votes"], 1234)
        self.assertEqual(m["rt_critic"], 91)
        self.assertEqual(m["metacritic"], 77)
        self.assertEqual(m["award"], "won")

    def test_a_title_with_no_imdb_id_is_skipped_without_a_call(self):
        m = _title(imdb_id=None)
        with mock.patch.object(pp, "get_json", side_effect=AssertionError("must not call OMDb")):
            self.assertIs(pp.enrich_omdb(m), m)


class BuildSurvivesAFailingOmdb(unittest.TestCase):
    """The acceptance criterion: a limit error degrades gracefully and the run still produces a catalogue."""

    def setUp(self):
        self.today = datetime.date(2026, 7, 24)
        # Titles that need a back-fill (no rating) so the OMDb path is actually exercised.
        self.base = [_title(i, imdb_rating=None, imdb_votes=None) for i in range(1, 6)]
        prov = {"jw_link": "https://jw/x",
                "rows": {"flatrate": [{"provider_name": "Netflix"}]}}
        patches = [
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "tmdb_providers", lambda tid: prov),
            mock.patch.object(pp, "has_provider_rows", lambda p: True),
            mock.patch.object(pp, "provider_offers", lambda p: [{"service": "Netflix", "type": "sub",
                                                                "price": None, "format": "HD"}]),
            mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]),
            mock.patch.object(pp, "TMDB_PACING", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _run(self):
        return pp.build_live_catalogue(self.today, self.base, {}, ondemand_ids=[])

    def test_omdb_401_does_not_abort_the_run(self):
        calls = []

        def boom(movie):
            calls.append(movie["tmdb_id"])
            raise _http_error(401, b'{"Response":"False","Error":"Request limit reached!"}')

        with mock.patch.object(pp, "enrich_omdb", boom):
            catalogue, counts = self._run()

        # The run completed and still produced every title — that is what gets committed.
        self.assertEqual(len(catalogue), len(self.base))
        self.assertTrue(counts["omdb_stopped"])
        # …and it stopped asking after the FIRST 401 rather than burning the rest of the catalogue on it.
        self.assertEqual(len(calls), 1)
        self.assertEqual(counts["omdb_fails"], 1)
        # Availability still came from TMDB providers, which never failed.
        self.assertTrue(all(m["availability_source"] == "tmdb_providers" for m in catalogue))

    def test_a_transient_omdb_error_skips_one_title_and_keeps_going(self):
        def flaky(movie):
            if movie["tmdb_id"] == 3:
                raise _http_error(503)
            movie["imdb_rating"] = 6.6
            return movie

        with mock.patch.object(pp, "enrich_omdb", flaky):
            catalogue, counts = self._run()

        self.assertEqual(len(catalogue), 5)
        self.assertFalse(counts["omdb_stopped"])          # transient: keep trying the other titles
        self.assertEqual(counts["omdb_fails"], 1)
        failed = [m for m in catalogue if m["tmdb_id"] == 3][0]
        self.assertIsNone(failed["imdb_rating"])          # kept exactly what it had
        self.assertEqual(sum(1 for m in catalogue if m.get("imdb_rating") == 6.6), 4)

    def test_a_failing_provider_call_keeps_yesterdays_window(self):
        """Availability is the one thing an estimate could silently corrupt, so a failed read must keep
        the stored answer AND must not claim a poll that did not happen."""
        self.base = [_title(1)]
        with mock.patch.object(pp, "tmdb_providers", side_effect=_http_error(500)), \
             mock.patch.object(pp, "enrich_omdb", lambda m: m):
            catalogue, counts = self._run()

        m = catalogue[0]
        self.assertEqual(counts["provider_fails"], 1)
        self.assertEqual(m["status"], ["included_streaming"])       # yesterday's real answer, untouched
        self.assertEqual(m["availability_confidence"], "confirmed")
        self.assertEqual(m["last_polled"], "2026-07-23")            # NOT restamped to today
        self.assertEqual(len(catalogue), 1)

    def test_a_never_polled_title_falls_back_to_an_estimate_not_to_nothing(self):
        self.base = [_title(9, status=[], offers=[], availability_confidence=None, last_polled=None)]
        with mock.patch.object(pp, "tmdb_providers", side_effect=_http_error(500)), \
             mock.patch.object(pp, "enrich_omdb", lambda m: m):
            catalogue, _ = self._run()
        self.assertTrue(catalogue[0]["status"])                     # it has SOME window
        self.assertEqual(catalogue[0]["availability_source"], "estimated_unpolled")


class BudgetsFitTheFreeTier(unittest.TestCase):
    def test_the_two_omdb_pots_share_one_daily_cap(self):
        """They are spent against ONE allowance, counted per key per day — so their SUM is what matters.
        It was 900+150 = 1050, already over before a single retry, which is how a second run the same day
        earned a 401."""
        total = pp.OMDB_DAILY_BUDGET + pp.OMDB_REFRESH_BUDGET
        self.assertLessEqual(total, pp.OMDB_FREE_TIER_CAP,
                             "OMDb budgets exceed the free-tier daily cap")
        self.assertLessEqual(total, pp.OMDB_FREE_TIER_CAP * 0.95,
                             "OMDb budgets leave no headroom for retries or a second run")


if __name__ == "__main__":
    unittest.main()
