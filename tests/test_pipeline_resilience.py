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
import poll_scheduler as ps


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
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "tmdb_providers", lambda tid: prov),
            mock.patch.object(pp, "has_provider_rows", lambda p: True),
            mock.patch.object(pp, "provider_offers", lambda p: [{"service": "Netflix", "type": "sub",
                                                                "price": None, "format": "HD"}]),
            mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]),
            mock.patch.object(pp, "TMDB_PACING", 0),
            # CAS-379: these titles predate cinema_release too, but this class is about OMDb
            # resilience — a no-op here keeps that backfill path from making its own network call.
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
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


def _tmdb_detail(release_dates_au, **kw):
    """A minimal TMDB /movie/{id} detail payload, AU release_dates only — enough for _tmdb_record to map."""
    d = {"id": 1, "imdb_id": "tt0000001", "title": "Test Film", "release_date": "2026-01-01",
         "genres": [], "production_countries": [], "original_language": "en",
         "release_dates": {"results": [{"iso_3166_1": "AU", "release_dates": release_dates_au}]},
         "videos": {"results": []}, "credits": {"cast": [], "crew": []}}
    d.update(kw)
    return d


class CinemaReleaseFromReleaseDates(unittest.TestCase):
    """CAS-360: every AU release_dates type is stored, and cinema_release is true only for a type-3 record."""

    def test_a_type_3_record_sets_cinema_release_true(self):
        m = pp._tmdb_record(_tmdb_detail([{"type": 3, "release_date": "2026-03-01T00:00:00.000Z",
                                            "certification": "M"}]))
        self.assertTrue(m["cinema_release"])
        self.assertEqual(m["release_dates"], [{"region": "AU", "type": 3, "date": "2026-03-01"}])

    def test_a_type_2_limited_record_does_not_set_cinema_release(self):
        """Type 2 (limited theatrical) still drives the existing cinema_date, but not the new type-3-only flag."""
        m = pp._tmdb_record(_tmdb_detail([{"type": 2, "release_date": "2026-03-01T00:00:00.000Z",
                                            "certification": "M"}]))
        self.assertFalse(m["cinema_release"])
        self.assertEqual(m["cinema_date"], "2026-03-01")   # unchanged behaviour
        self.assertEqual(m["release_dates"], [{"region": "AU", "type": 2, "date": "2026-03-01"}])

    def test_every_type_is_persisted_even_though_only_type_3_is_acted_on(self):
        m = pp._tmdb_record(_tmdb_detail([
            {"type": 4, "release_date": "2026-02-01T00:00:00.000Z", "certification": ""},
            {"type": 3, "release_date": "2026-03-01T00:00:00.000Z", "certification": "M"},
            {"type": 6, "release_date": "2026-06-01T00:00:00.000Z", "certification": ""},
        ]))
        self.assertTrue(m["cinema_release"])
        self.assertEqual([rd["type"] for rd in m["release_dates"]], [4, 3, 6])

    def test_no_au_release_dates_leaves_cinema_release_false(self):
        m = pp._tmdb_record(_tmdb_detail([]))
        self.assertFalse(m["cinema_release"])
        self.assertEqual(m["release_dates"], [])


def _release_dates_payload(release_dates_au):
    """A minimal TMDB /movie/{id}/release_dates payload — the lighter, dedicated endpoint
    enrich_cinema_release uses for the CAS-379 back-fill (results at the top level, unlike the
    full /movie/{id} detail's release_dates.results nesting _tmdb_record reads)."""
    return {"id": 1, "results": [{"iso_3166_1": "AU", "release_dates": release_dates_au}]}


class EnrichCinemaReleaseBackfillsAnOldRecord(unittest.TestCase):
    """CAS-379: enrich_cinema_release is the one-off back-fill for a record built before CAS-360
    ever gave it a cinema_release key."""

    def test_a_type_3_release_sets_cinema_release_true(self):
        m = {"tmdb_id": 1}
        with mock.patch.object(pp, "get_json", return_value=_release_dates_payload(
                [{"type": 3, "release_date": "2026-03-01T00:00:00.000Z"}])):
            pp.enrich_cinema_release(m)
        self.assertTrue(m["cinema_release"])
        self.assertEqual(m["release_dates"], [{"region": "AU", "type": 3, "date": "2026-03-01"}])

    def test_no_type_3_release_leaves_it_false(self):
        m = {"tmdb_id": 1}
        with mock.patch.object(pp, "get_json", return_value=_release_dates_payload(
                [{"type": 2, "release_date": "2026-03-01T00:00:00.000Z"}])):
            pp.enrich_cinema_release(m)
        self.assertFalse(m["cinema_release"])


class CinemaReleaseBackfillDuringBuild(unittest.TestCase):
    """CAS-379: the "Only movies that had a Cinema Release" toggle read 0 films because every
    catalogue record predates cinema_release (CAS-360) — build_live_catalogue carries base records
    forward unchanged, so the field never existed on any of them. It must notice a record with no
    cinema_release key at all and back-fill it under its own budget, leaving a record that already
    carries the key (even False) untouched."""

    def setUp(self):
        self.today = datetime.date(2026, 8, 5)
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
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _run(self, base):
        return pp.build_live_catalogue(self.today, base, {}, ondemand_ids=[])

    def test_a_record_missing_the_key_gets_backfilled(self):
        m = _title(1)
        self.assertNotIn("cinema_release", m)
        with mock.patch.object(pp, "enrich_cinema_release",
                               lambda mv: mv.update(cinema_release=True, release_dates=[]) or mv):
            catalogue, counts = self._run([m])
        self.assertTrue(catalogue[0]["cinema_release"])
        self.assertEqual(counts["cinema_calls"], 1)

    def test_a_record_that_already_has_the_key_is_left_alone(self):
        m = _title(1, cinema_release=False)
        with mock.patch.object(pp, "enrich_cinema_release",
                               side_effect=AssertionError("must not re-fetch a record that already has the field")):
            catalogue, counts = self._run([m])
        self.assertFalse(catalogue[0]["cinema_release"])
        self.assertEqual(counts["cinema_calls"], 0)

    def test_the_backfill_budget_caps_calls_per_run(self):
        base = [_title(i) for i in range(1, 4)]
        with mock.patch.object(pp, "CINEMA_RELEASE_BACKFILL_BUDGET", 2), \
             mock.patch.object(pp, "enrich_cinema_release",
                               lambda mv: mv.update(cinema_release=True, release_dates=[]) or mv):
            catalogue, counts = self._run(base)
        self.assertEqual(counts["cinema_calls"], 2)
        self.assertEqual(sum(1 for m in catalogue if "cinema_release" in m), 2)

    def test_a_stopping_error_halts_the_backfill_for_the_rest_of_the_run(self):
        base = [_title(i) for i in range(1, 4)]
        calls = []

        def boom(mv):
            calls.append(mv["tmdb_id"])
            raise _http_error(401, b'{"status_message":"Invalid API key"}')

        with mock.patch.object(pp, "enrich_cinema_release", boom):
            catalogue, counts = self._run(base)
        self.assertEqual(len(calls), 1)
        self.assertTrue(counts["cinema_stopped"])
        self.assertEqual(counts["cinema_fails"], 1)


def _wikidata_payload(rows):
    """A minimal Wikidata SPARQL JSON results shape — one binding per (category, result[, person])."""
    bindings = []
    for category, result, person in rows:
        b = {"awardLabel": {"value": category}, "result": {"value": result}}
        if person:
            b["personLabel"] = {"value": person}
        bindings.append(b)
    return {"results": {"bindings": bindings}}


class EnrichWikidataAwardsParsesTheSparqlResult(unittest.TestCase):
    """CAS-322: turn Wikidata's SPARQL rows into { category, result, person? } entries."""

    def test_a_film_level_win_has_no_person(self):
        m = {"imdb_id": "tt0000001"}
        with mock.patch.object(pp, "get_json", return_value=_wikidata_payload(
                [("Academy Award for Best Picture", "Won", None)])):
            pp.enrich_wikidata_awards(m)
        self.assertEqual(m["oscar_detail"],
                         [{"category": "Academy Award for Best Picture", "result": "Won"}])
        self.assertTrue(m["oscar_detail_checked"])

    def test_a_personal_category_carries_the_winner(self):
        m = {"imdb_id": "tt0000002"}
        with mock.patch.object(pp, "get_json", return_value=_wikidata_payload(
                [("Academy Award for Best Director", "Won", "Christopher Nolan")])):
            pp.enrich_wikidata_awards(m)
        self.assertEqual(m["oscar_detail"], [{"category": "Academy Award for Best Director",
                                              "result": "Won", "person": "Christopher Nolan"}])

    def test_no_rows_caches_an_empty_list_not_a_missing_field(self):
        m = {"imdb_id": "tt0000003"}
        with mock.patch.object(pp, "get_json", return_value=_wikidata_payload([])):
            pp.enrich_wikidata_awards(m)
        self.assertEqual(m["oscar_detail"], [])
        self.assertTrue(m["oscar_detail_checked"])


class WikidataAwardBackfillDuringBuild(unittest.TestCase):
    """CAS-322: only a title OMDb already flagged as having Oscar activity (`award` won/nominated)
    is looked up, and only once — a bounded, converging backfill, not a per-run full sweep."""

    def setUp(self):
        self.today = datetime.date(2026, 8, 6)
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
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "WIKIDATA_PACING", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _run(self, base):
        return pp.build_live_catalogue(self.today, base, {}, ondemand_ids=[])

    def test_an_awarded_title_gets_backfilled(self):
        m = _title(1, cinema_release=True, award="won")
        with mock.patch.object(pp, "enrich_wikidata_awards",
                               lambda mv: mv.update(oscar_detail=[{"category": "Best Picture",
                                                                    "result": "Won"}],
                                                     oscar_detail_checked=True) or mv):
            catalogue, counts = self._run([m])
        self.assertEqual(catalogue[0]["oscar_detail"], [{"category": "Best Picture", "result": "Won"}])
        self.assertEqual(counts["wikidata_calls"], 1)

    def test_a_title_with_no_award_is_never_queried(self):
        m = _title(1, cinema_release=True)
        with mock.patch.object(pp, "enrich_wikidata_awards",
                               side_effect=AssertionError("must not query a title with no award flag")):
            catalogue, counts = self._run([m])
        self.assertNotIn("oscar_detail", catalogue[0])
        self.assertEqual(counts["wikidata_calls"], 0)

    def test_an_already_checked_title_is_left_alone(self):
        m = _title(1, cinema_release=True, award="won", oscar_detail=[], oscar_detail_checked=True)
        with mock.patch.object(pp, "enrich_wikidata_awards",
                               side_effect=AssertionError("must not re-query an already-checked title")):
            catalogue, counts = self._run([m])
        self.assertEqual(counts["wikidata_calls"], 0)

    def test_the_backfill_budget_caps_calls_per_run(self):
        base = [_title(i, cinema_release=True, award="won") for i in range(1, 4)]
        with mock.patch.object(pp, "WIKIDATA_BACKFILL_BUDGET", 2), \
             mock.patch.object(pp, "enrich_wikidata_awards",
                               lambda mv: mv.update(oscar_detail=[], oscar_detail_checked=True) or mv):
            catalogue, counts = self._run(base)
        self.assertEqual(counts["wikidata_calls"], 2)
        self.assertEqual(sum(1 for m in catalogue if m.get("oscar_detail_checked")), 2)

    def test_a_stopping_error_halts_the_backfill_for_the_rest_of_the_run(self):
        base = [_title(i, cinema_release=True, award="won") for i in range(1, 4)]
        calls = []

        def boom(mv):
            calls.append(mv["tmdb_id"])
            raise _http_error(401, b'{"error":"limited"}')

        with mock.patch.object(pp, "enrich_wikidata_awards", boom):
            catalogue, counts = self._run(base)
        self.assertEqual(len(calls), 1)
        self.assertTrue(counts["wikidata_stopped"])
        self.assertEqual(counts["wikidata_fails"], 1)


class OmdbBackfillIsPrioritised(unittest.TestCase):
    """CAS-384: walking `catalogue` in popularity order let a handful of popular slow-tier titles
    exhaust the budget before every active title got scored, and a title skipped one run had no
    better odds of being reached the next. Order must be (active tier first, then oldest
    last_polled), reusing the poll_tier/last_polled fields CAS-109 already writes."""

    def setUp(self):
        self.today = datetime.date(2026, 8, 5)
        prov = {"jw_link": "https://jw/x", "rows": {"flatrate": [{"provider_name": "Netflix"}]}}
        patches = [
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "has_provider_rows", lambda p: True),
            mock.patch.object(pp, "provider_offers", lambda p: [{"service": "Netflix", "type": "sub",
                                                                "price": None, "format": "HD"}]),
            mock.patch.object(pp, "derive_from_providers", lambda m, p, t: ["included_streaming"]),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
            mock.patch.object(pp, "OMDB_DAILY_BUDGET", 1),
            mock.patch.object(pp, "OMDB_REFRESH_BUDGET", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)
        self._prov = prov

    def _run(self, base):
        return pp.build_live_catalogue(self.today, base, {}, ondemand_ids=[])

    def test_active_tier_is_backfilled_before_slow_tier(self):
        # Far more popular, but settled on streaming long ago (slow tier).
        slow = _title(1, cinema_date="2024-01-01", status=["included_streaming"],
                      imdb_rating=None, imdb_votes=None, popularity=100.0)
        # Barely popular, but just opened in cinemas (active tier).
        active = _title(2, cinema_date=self.today.isoformat(), status=[],
                        imdb_rating=None, imdb_votes=None, popularity=1.0)
        calls = []

        def spy(m):
            calls.append(m["tmdb_id"]); m["imdb_rating"] = 5.0; return m

        with mock.patch.object(pp, "tmdb_providers", lambda tid: self._prov), \
             mock.patch.object(pp, "enrich_omdb", spy):
            self._run([slow, active])

        self.assertEqual(calls, [2], "active tier must be backfilled before slow tier regardless of popularity")

    def test_within_a_tier_a_stale_last_polled_title_goes_first(self):
        # Both slow tier and equally released; one's TMDB-provider poll fails this run so its
        # last_polled stays old, the other's succeeds and gets stamped today.
        fresh = _title(1, cinema_date="2024-01-01", status=["included_streaming"],
                       imdb_rating=None, imdb_votes=None, last_polled="2026-08-04", popularity=100.0)
        stale = _title(2, cinema_date="2024-01-01", status=["included_streaming"],
                       imdb_rating=None, imdb_votes=None, last_polled="2026-01-01", popularity=1.0)

        def prov(tid):
            if tid == 2:
                raise _http_error(500)
            return self._prov

        calls = []

        def spy(m):
            calls.append(m["tmdb_id"]); m["imdb_rating"] = 5.0; return m

        with mock.patch.object(pp, "tmdb_providers", prov), mock.patch.object(pp, "enrich_omdb", spy):
            self._run([fresh, stale])

        self.assertEqual(calls, [2], "the title with the oldest last_polled must be backfilled first")


class CrossRunDailySpendSharesOneCap(unittest.TestCase):
    """CAS-384: OMDb's free tier is counted per key per day, not per run (CAS-161's own comment: "how a
    second run happened the same day" earned the 2026-07-24 401 — and the same shape recurred on
    2026-08-05). A second run the same day must see what an earlier run already spent."""

    def setUp(self):
        self.today = datetime.date(2026, 8, 5)
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
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_a_second_same_day_run_gets_a_shrunk_pot(self):
        base = [_title(i, imdb_rating=None, imdb_votes=None) for i in range(1, 4)]
        with mock.patch.object(pp, "enrich_omdb", lambda m: m.update(imdb_rating=5.0) or m):
            _, counts = pp.build_live_catalogue(
                self.today, base, {}, ondemand_ids=[],
                omdb_spent_today=pp.OMDB_FREE_TIER_CAP - 1)   # only one call left in today's real cap
        self.assertEqual(counts["omdb_calls"], 1)

    def test_a_fully_spent_day_makes_no_omdb_calls(self):
        base = [_title(i, imdb_rating=None, imdb_votes=None) for i in range(1, 4)]
        with mock.patch.object(pp, "enrich_omdb",
                               side_effect=AssertionError("must not call OMDb — today's cap is already spent")):
            _, counts = pp.build_live_catalogue(
                self.today, base, {}, ondemand_ids=[], omdb_spent_today=pp.OMDB_FREE_TIER_CAP)
        self.assertEqual(counts["omdb_calls"], 0)


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


class TheWindowEstimatorCannotLearnFromItsOwnStartDate(unittest.TestCase):
    """CAS-237: the estimator taught itself that films reach streaming the day after they open.

    `window_dates` is an OBSERVATION log — the date Cascade first SAW a film in each window, not the date the
    film moved — so every title that was already streaming when polling began got its cinema stamp and its
    streaming stamp on the same day. `compute_median_offsets` averaged those and learned
    {pvod: 75, rental: 0, included_streaming: 1}. `estimate_status` then filed every unpolled released film
    straight onto streaming: 1,614 of 1,961 titles, not one of them in a cinema, which is why a cinema agent
    had no In Cinema section to fill.

    The structural point, and the reason a floor rather than a smarter average is the fix: a median cannot
    come out longer than the log is old. Eighteen days in, no amount of data could have produced a 210-day
    streaming offset — so any short answer that early is a fact about the start date, not about films.
    """

    def test_an_observation_log_teaches_it_nothing(self):
        # Twenty films, each stamped in every window on the same day: exactly the shape of a catalogue that
        # was already released when polling started. It must learn nothing from them.
        log = {str(i): {"in_cinema": "2026-07-12", "rental": "2026-07-12",
                        "included_streaming": "2026-07-13"} for i in range(20)}
        self.assertEqual(ps.compute_median_offsets(log), ps.DEFAULT_OFFSETS,
                         "the estimator learned release windows from the day it started looking")

    def test_a_journey_it_actually_followed_does_teach_it(self):
        # The same twenty films, but seen BEFORE they opened — so the gaps are real moves, not first sightings.
        log = {str(i): {"upcoming": "2025-01-01", "in_cinema": "2025-02-01",
                        "pvod": "2025-05-01", "rental": "2025-06-01",
                        "included_streaming": "2025-10-01"} for i in range(20)}
        got = ps.compute_median_offsets(log)
        self.assertEqual(got, {"pvod": 89, "rental": 120, "included_streaming": 242},
                         f"a followed journey should be learned verbatim, got {got}")

    def test_an_implausibly_short_offset_falls_back_to_the_default(self):
        got = ps._sane_offsets({"pvod": 0, "rental": 0, "included_streaming": 1})
        self.assertEqual(got, ps.DEFAULT_OFFSETS, "a zero-day window was taken as a fact")

    def test_the_journey_can_never_run_backwards(self):
        # Out-of-order offsets make estimate_status file a film into whichever test fires first, which is an
        # accident rather than a window.
        got = ps._sane_offsets({"pvod": 200, "rental": 100, "included_streaming": 300})
        self.assertLessEqual(got["pvod"], got["rental"])
        self.assertLessEqual(got["rental"], got["included_streaming"])

    def test_a_film_that_opened_last_week_is_estimated_into_a_cinema(self):
        # The user-visible claim, end to end: this is the film the report was about.
        today = datetime.date(2026, 7, 30)
        m = {"cinema_date": "2026-07-17"}
        self.assertEqual(ps.estimate_status(m, today, ps.DEFAULT_OFFSETS), ("in_cinema", "estimated"))
        # …and it is still true when the caller hands over a broken offset table, because estimate_status
        # sanitises whatever it is given rather than trusting it.
        self.assertEqual(ps.estimate_status(m, today, {"pvod": 0, "rental": 0, "included_streaming": 1}),
                         ("in_cinema", "estimated"))

    def test_the_ladder_still_moves_a_film_along_it(self):
        # The floor must not turn the estimator into "everything is in a cinema forever".
        today = datetime.date(2026, 7, 30)
        for age, expected in ((5, "in_cinema"), (80, "pvod"), (150, "rental"), (400, "included_streaming")):
            opened = (today - datetime.timedelta(days=age)).isoformat()
            got, conf = ps.estimate_status({"cinema_date": opened}, today)
            self.assertEqual(got, expected, f"a film {age} days out was estimated {got}")
            self.assertEqual(conf, "estimated")

    def test_an_unreleased_film_is_never_estimated_into_a_cinema(self):
        today = datetime.date(2026, 7, 30)
        self.assertEqual(ps.estimate_status({"cinema_date": "2026-12-01"}, today), ("upcoming", "estimated"))
        self.assertEqual(ps.estimate_status({}, today), ("upcoming", "estimated"))

    def test_the_estimated_in_cinema_window_is_capped_at_a_realistic_run_length(self):
        # CAS-476: the original two-week cap deleted two real, still-showing wide releases (Toy Story 5, 55
        # days into its run; The Odyssey, 27 days in) — past the cap, app_template.html's twin correction
        # filed them onto "pvod" with zero offers, which is unshowable without a real one, so the film
        # vanished instead of moving to a visible next window. Raised to DEFAULT_OFFSETS["pvod"] (75 days),
        # the same median cinema-to-pvod gap already trusted for this exact question elsewhere in this module.
        today = datetime.date(2026, 8, 12)
        opened_74_days_ago = (today - datetime.timedelta(days=74)).isoformat()
        self.assertEqual(ps.estimate_status({"cinema_date": opened_74_days_ago}, today),
                         ("in_cinema", "estimated"))
        opened_75_days_ago = (today - datetime.timedelta(days=75)).isoformat()
        self.assertEqual(ps.estimate_status({"cinema_date": opened_75_days_ago}, today),
                         ("pvod", "estimated"), "the estimated in-cinema window ran past its realistic-run cap")
        # The cap must stay an INDEPENDENT ceiling (its documented job) even against a learned pvod offset
        # that is longer than it — not just a value that happens to match the current default.
        opened_60_days_ago = (today - datetime.timedelta(days=60)).isoformat()
        long_offsets = {"pvod": 120, "rental": 150, "included_streaming": 250}
        self.assertEqual(ps.estimate_status({"cinema_date": opened_60_days_ago}, today, long_offsets),
                         ("in_cinema", "estimated"))
        opened_80_days_ago = (today - datetime.timedelta(days=80)).isoformat()
        self.assertEqual(ps.estimate_status({"cinema_date": opened_80_days_ago}, today, long_offsets),
                         ("pvod", "estimated"),
                         "a learned pvod offset longer than the cap must not override the independent ceiling")
        # The two real titles that prompted CAS-476, expressed as regression cases against today's date.
        toy_story_5 = (today - datetime.timedelta(days=55)).isoformat()
        self.assertEqual(ps.estimate_status({"cinema_date": toy_story_5}, today)[0], "in_cinema",
                         "Toy Story 5 (55 days into its run) must stay in_cinema, not vanish past a too-short cap")
        the_odyssey = (today - datetime.timedelta(days=27)).isoformat()
        self.assertEqual(ps.estimate_status({"cinema_date": the_odyssey}, today)[0], "in_cinema")


if __name__ == "__main__":
    unittest.main()
