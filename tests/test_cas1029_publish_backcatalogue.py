"""CAS-1029 — publish scored back-catalogue candidates: every candidate that already carries
Watchmode scores clearing the publish floor, and that the shipped engine (tests/js/engine.mjs, the
same real-engine call CAS-986 uses — never a second copy of the scoring rule) calls scoreable
today, gets the same TMDB-only enrichment any normally-discovered title gets and, once that makes
it a publishable record, reaches movies.json. A candidate below the floor is left alone. No
Watchmode endpoint is ever called on this path — the scores are already fetched; this ticket must
cost 0 Watchmode credits.

Run: python -m unittest tests.test_cas1029_publish_backcatalogue
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp

_TODAY = datetime.date(2026, 9, 17)


def _scored_stub(tmdb_id, wm_user_rating, popularity=5.0):
    """The exact shape state/candidates.json carries for a Watchmode-scored-only entry (CAS-991's
    merge_backcatalogue_candidates + CAS-1023's scoreability probe) — int year, no TMDB fields."""
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": 2019, "popularity": popularity,
            "popularity_percentile": 80, "status": [], "first_seen": "2026-01-01",
            "last_probed": "2026-09-16", "probe_count": 1, "outcome": "scored",
            "wm_user_rating": wm_user_rating, "wm_fields_fetched_at": "2026-09-16"}


def _tmdb_detail(tmdb_id, release_date="2019-03-01"):
    return {
        "id": tmdb_id, "title": f"T{tmdb_id}", "imdb_id": "tt1234567",
        "release_date": release_date, "genres": [{"name": "Drama"}],
        "release_dates": {"results": [{"iso_3166_1": "AU", "release_dates": [
            {"type": 3, "release_date": f"{release_date}T00:00:00.000Z", "certification": "M"},
        ]}]},
        "original_language": "en", "production_countries": [{"iso_3166_1": "US"}],
        "videos": {"results": []}, "credits": {"crew": [], "cast": []},
        "revenue": 0, "budget": 0, "popularity": 12.0,
        "overview": "A real synopsis.", "poster_path": "/poster.jpg",
    }


def _fake_get_json(providers=None):
    providers = providers if providers is not None else {"flatrate": [{"provider_name": "Netflix"}]}

    def _get(url):
        if "/watch/providers" in url:
            return {"results": {"AU": providers}}
        tmdb_id = int(url.split(f"{pp.TMDB_BASE}/movie/")[1].split("?")[0])
        return _tmdb_detail(tmdb_id)
    return _get


def _never_call_watchmode():
    """Every credit-costing/Watchmode-endpoint function this path must never touch, mocked to
    blow up on any call — the "mocked Watchmode client that fails on any call" the AC asks for."""
    boom = mock.Mock(side_effect=AssertionError("this path must spend 0 Watchmode credits"))
    return mock.patch.multiple(
        pp,
        _fetch_watchmode_title_details=boom,
        _fetch_watchmode_idmap=boom,
        _fetch_watchmode_status=boom,
        _list_watchmode_titles_page=boom,
        poll_watchmode=boom,
    )


class PublishesOnlyAboveFloorCandidates(unittest.TestCase):
    """AC1 — fixture candidates above and below the floor: only the above-floor one is enriched
    and published, with a full record shape, and zero Watchmode calls throughout."""

    def test_above_floor_enriched_and_published_below_floor_left_alone(self):
        above_floor = _scored_stub(1, wm_user_rating=9.0, popularity=50)   # qScore ~90
        below_floor = _scored_stub(2, wm_user_rating=1.0, popularity=10)   # qScore ~10
        candidates = {"1": above_floor, "2": below_floor}

        with _never_call_watchmode():
            engine_ids = pp.scoreable_ids(list(candidates.values()), floor=pp.WM_PUBLISH_FLOOR)
            self.assertIn(1, engine_ids)
            self.assertNotIn(2, engine_ids)

            with mock.patch.object(pp, "get_json", side_effect=_fake_get_json()):
                enrich_stats = pp.enrich_candidates_for_publication(candidates, engine_ids, _TODAY)

            published, pub_stats = pp.select_publishable(
                candidates, engine_ids, previously_published_ids=set(), held_ids=set(),
                catalogue_target=100)

        self.assertEqual(enrich_stats["eligible"], 1)
        self.assertEqual(enrich_stats["enriched"], 1)
        self.assertEqual(enrich_stats["failed"], 0)

        self.assertEqual({m["tmdb_id"] for m in published}, {1})
        self.assertEqual(pub_stats["promoted"], 1)

        record = candidates["1"]
        self.assertIsInstance(record["year"], str)
        self.assertTrue(record.get("cinema_date"))
        self.assertIsInstance(record["status"], list)
        self.assertTrue(record["status"])
        self.assertIn("release_dates", record)
        self.assertEqual(record["poster"], "/poster.jpg")
        self.assertEqual(record["genres"], ["Drama"])
        # CAS-1023's scoreability fields must survive TMDB enrichment untouched.
        self.assertEqual(record["wm_user_rating"], 9.0)

        # The below-floor candidate was never touched: still the raw stub, never published.
        self.assertEqual(candidates["2"], below_floor)
        self.assertFalse(pp.is_publishable_record(candidates["2"]))

    def test_the_enrich_log_line_has_the_ticket_s_literal_shape(self):
        stats = {"eligible": 3, "enriched": 2, "failed": 1, "reasons": {"stop": 1}}
        line = pp.publish_enrich_log_line(stats, published=2)
        self.assertEqual(
            line, "[enrich] eligible 3, enriched 2, published 2, failed 1 (stop=1)")


class ResumableAcrossAKilledRun(unittest.TestCase):
    """Change item 4 — a run that cannot finish the full eligible set in one pass must not lose
    completed work: candidates.json is saved mid-batch, not only at the very end."""

    def test_candidates_are_saved_mid_batch_not_only_at_the_end(self):
        candidates = {str(i): _scored_stub(i, wm_user_rating=9.0, popularity=i) for i in range(1, 4)}
        engine_ids = {1, 2, 3}

        with mock.patch.object(pp, "PUBLISH_ENRICH_SAVE_EVERY", 1), \
             mock.patch.object(pp, "get_json", side_effect=_fake_get_json()), \
             mock.patch.object(pp, "save_candidates") as save_fn, \
             mock.patch.object(pp, "time") as time_mod:
            pp.enrich_candidates_for_publication(candidates, engine_ids, _TODAY)

        self.assertEqual(save_fn.call_count, 3)
        self.assertEqual(time_mod.sleep.call_count, 3)

    def test_a_failed_enrichment_call_is_tallied_by_reason_not_silently_dropped(self):
        candidates = {"1": _scored_stub(1, wm_user_rating=9.0)}
        with mock.patch.object(pp, "get_json", side_effect=RuntimeError("boom")):
            stats = pp.enrich_candidates_for_publication(candidates, {1}, _TODAY)

        self.assertEqual(stats["eligible"], 1)
        self.assertEqual(stats["enriched"], 0)
        self.assertEqual(stats["failed"], 1)
        self.assertEqual(stats["reasons"], {"skip": 1})


if __name__ == "__main__":
    unittest.main()
