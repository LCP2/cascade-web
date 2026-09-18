"""CAS-1027 — the publication guard: no candidate-pool stub (CAS-991's
merge_backcatalogue_candidates shape) may ever reach movies.json, whichever path writes it.

The defect: CAS-1024's back-catalogue dispatch published 71 raw candidate stubs — an int `year`,
none of the TMDB fields the app/engine need — because the Watchmode scoreability probe alone was
enough to make the shipped engine call a candidate scoreable, and nothing checked the record was
actually fit to publish. This covers the guard (is_publishable_record), the TMDB-only repair pass
(enrich_candidate_for_publication / enrich_candidates_for_publication), and select_publishable's
own refusal to publish a stub even when the engine says it's scoreable.

Run: python -m unittest tests.test_cas1027_publication_guard
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp

_TODAY = datetime.date(2026, 9, 17)


def _backcat_stub(tmdb_id, **wm_fields):
    """The exact shape CAS-991's merge_backcatalogue_candidates writes, after CAS-1023's
    scoreability probe has added its wm_* fields — the shape the real 71-record defect shipped."""
    stub = {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": 2018, "popularity": 5.0,
            "popularity_percentile": 90, "status": [], "first_seen": "2026-01-01",
            "last_probed": "2026-09-16", "probe_count": 1, "outcome": "scored"}
    stub.update(wm_fields)
    return stub


def _tmdb_detail(tmdb_id, title="A Real Film", release_date="2018-04-25"):
    return {
        "id": tmdb_id, "title": title, "imdb_id": "tt1234567",
        "release_date": release_date, "genres": [{"name": "Action"}],
        "release_dates": {"results": [{"iso_3166_1": "AU", "release_dates": [
            {"type": 3, "release_date": f"{release_date}T00:00:00.000Z", "certification": "M"},
        ]}]},
        "original_language": "en", "production_countries": [{"iso_3166_1": "US"}],
        "videos": {"results": []}, "credits": {"crew": [], "cast": []},
        "revenue": 2000000000, "budget": 300000000, "popularity": 88.0,
        "overview": "A real synopsis.", "poster_path": "/poster.jpg",
    }


def _fake_get_json(providers=None):
    """A `poc_pipeline.get_json` stand-in keyed on the URL shape: the movie detail call
    (revalidate_record) vs. the watch/providers call (tmdb_providers) — the two TMDB-only calls
    enrich_candidate_for_publication makes, mirroring build_live_catalogue's own real call sites."""
    providers = providers if providers is not None else {}

    def _get(url):
        if "/watch/providers" in url:
            return {"results": {"AU": providers}}
        tmdb_id = int(url.split(f"{pp.TMDB_BASE}/movie/")[1].split("?")[0])
        return _tmdb_detail(tmdb_id)
    return _get


class IsPublishableRecord(unittest.TestCase):
    def test_a_raw_backcatalogue_stub_is_rejected(self):
        self.assertFalse(pp.is_publishable_record(_backcat_stub(1, wm_user_rating=8.0)))

    def test_an_int_year_with_no_cinema_date_is_rejected_even_with_other_fields(self):
        # A record that LOOKS bigger than the stub set but still fails the honesty check: year is
        # not a string and there is no cinema_date to fall back on.
        record = {**_backcat_stub(1), "offers": [], "genres": ["Action"]}
        self.assertFalse(pp.is_publishable_record(record))

    def test_a_fully_enriched_record_is_accepted(self):
        record = {"tmdb_id": 1, "title": "T1", "year": "2018", "cinema_date": "2018-04-25",
                  "genres": ["Action"], "release_dates": [], "status": ["included_streaming"],
                  "offers": [{"service": "Netflix", "type": "sub"}],
                  "wm_user_rating": 8.0}
        self.assertTrue(pp.is_publishable_record(record))

    def test_a_string_cinema_date_alone_is_enough_without_a_string_year(self):
        record = {**_backcat_stub(1), "cinema_date": "2018-04-25", "offers": []}
        self.assertTrue(pp.is_publishable_record(record))


class EnrichCandidateForPublication(unittest.TestCase):
    def test_a_stub_is_enriched_into_a_publishable_record_with_a_home_offer(self):
        candidate = _backcat_stub(1, wm_user_rating=8.5, wm_critic_score=90,
                                  wm_popularity_percentile=95, wm_fields_fetched_at="2026-09-16")
        with mock.patch.object(pp, "get_json",
                               side_effect=_fake_get_json(providers={"flatrate": [
                                   {"provider_name": "Netflix"}]})):
            outcome = pp.enrich_candidate_for_publication(candidate, _TODAY)

        self.assertEqual(outcome, "ok")
        self.assertTrue(pp.is_publishable_record(candidate), "still not publishable after enrichment")
        self.assertIsInstance(candidate["year"], str)
        self.assertEqual(candidate["status"], ["included_streaming"])
        self.assertEqual(candidate["offers"][0]["service"], "Netflix")
        # CAS-1023's scoreability probe fields must survive TMDB enrichment untouched.
        self.assertEqual(candidate["wm_user_rating"], 8.5)
        self.assertEqual(candidate["wm_critic_score"], 90)
        self.assertEqual(candidate["wm_fields_fetched_at"], "2026-09-16")

    def test_a_stub_with_no_au_offer_gets_the_honest_offerless_window(self):
        candidate = _backcat_stub(2, wm_user_rating=7.0)
        with mock.patch.object(pp, "get_json", side_effect=_fake_get_json(providers={})):
            outcome = pp.enrich_candidate_for_publication(candidate, _TODAY)

        self.assertEqual(outcome, "ok")
        self.assertTrue(pp.is_publishable_record(candidate))
        self.assertEqual(candidate["offers"], [])
        # An 8-year-old title with no AU offer at all is honestly past its run — _offerless_window's
        # own "released" answer, never invented availability.
        self.assertEqual(candidate["status"], ["released"])

    def test_a_failed_tmdb_detail_call_leaves_the_stub_untouched_for_retry_next_run(self):
        candidate = _backcat_stub(3, wm_user_rating=6.0)
        before = dict(candidate)
        with mock.patch.object(pp, "get_json", side_effect=RuntimeError("boom")):
            outcome = pp.enrich_candidate_for_publication(candidate, _TODAY)

        self.assertNotEqual(outcome, "ok")
        self.assertEqual(candidate, before, "a failed enrichment call must not partially mutate the stub")
        self.assertFalse(pp.is_publishable_record(candidate))


class EnrichCandidatesForPublicationBatch(unittest.TestCase):
    def test_only_engine_scoreable_non_publishable_candidates_are_touched(self):
        already_good = {"tmdb_id": 1, "title": "T1", "year": "2018", "cinema_date": "2018-04-25",
                        "genres": [], "release_dates": [], "status": ["included_streaming"],
                        "offers": [], "wm_user_rating": 8.0}
        stub_in_scope = _backcat_stub(2, wm_user_rating=8.0)
        stub_out_of_scope = _backcat_stub(3, wm_user_rating=8.0)   # engine didn't call this scoreable
        candidates = {"1": already_good, "2": stub_in_scope, "3": stub_out_of_scope}

        detail_calls = []
        def _get(url):
            if "/watch/providers" in url:
                return {"results": {"AU": {}}}
            detail_calls.append(url)
            tmdb_id = int(url.split(f"{pp.TMDB_BASE}/movie/")[1].split("?")[0])
            return _tmdb_detail(tmdb_id)

        with mock.patch.object(pp, "get_json", side_effect=_get):
            stats = pp.enrich_candidates_for_publication(candidates, {1, 2}, _TODAY)

        self.assertEqual(stats, {"eligible": 1, "enriched": 1, "failed": 0, "reasons": {}})
        self.assertEqual(len(detail_calls), 1)   # never re-fetched the already-good record
        self.assertTrue(pp.is_publishable_record(candidates["2"]))
        self.assertFalse(pp.is_publishable_record(candidates["3"]))   # left alone, out of scope


class SelectPublishableRefusesAStub(unittest.TestCase):
    """AC3's own regression case, at the layer CAS-1024's dispatch actually calls: the engine
    saying a candidate is scoreable is not enough — select_publishable must still refuse it."""

    def test_a_scoreable_stub_is_never_published(self):
        candidates = {"1": _backcat_stub(1, wm_user_rating=8.5)}
        published, stats = pp.select_publishable(candidates, engine_scoreable_ids={1},
                                                 previously_published_ids=set(), held_ids=set(),
                                                 catalogue_target=10)
        self.assertEqual(published, [])
        self.assertEqual(stats["published"], 0)

    def test_the_same_candidate_publishes_once_enriched(self):
        candidate = _backcat_stub(1, wm_user_rating=8.5)
        with mock.patch.object(pp, "get_json",
                               side_effect=_fake_get_json(providers={"rent": [
                                   {"provider_name": "Apple TV"}]})):
            pp.enrich_candidate_for_publication(candidate, _TODAY)
        candidates = {"1": candidate}
        published, stats = pp.select_publishable(candidates, engine_scoreable_ids={1},
                                                 previously_published_ids=set(), held_ids=set(),
                                                 catalogue_target=10)
        self.assertEqual({m["tmdb_id"] for m in published}, {1})
        self.assertEqual(stats["published"], 1)


if __name__ == "__main__":
    unittest.main()
