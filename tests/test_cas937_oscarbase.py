"""CAS-937 — Oscar award status + detail from OscarBase (free, no API key, 100 req/min),
replacing OMDb's Awards field and the retired Wikidata SPARQL detail backfill.

Every test here mocks the network. Nothing reaches OscarBase, TMDB, OMDb or Watchmode.
"""
import datetime
import io
import unittest
import urllib.error
from unittest import mock

import poc_pipeline as pp


def _http_error(code, body=b""):
    return urllib.error.HTTPError("https://api.oscarbase.com/", code, "err", {}, io.BytesIO(body))


def _listing(rows):
    return {"data": rows, "pagination": {"total": len(rows)}}


def _detail(nominations):
    return {"data": {"nominations": nominations}}


def _nom(category, nominee, winner, ceremony_year=2024):
    return {"category": category, "nominee": nominee, "winner": winner, "ceremony_year": ceremony_year}


class OscarbaseAwardStateReducesNominations(unittest.TestCase):
    """`_oscarbase_award_state` turns OscarBase's flat nomination rows into (award, award_text,
    oscar_detail) — the same {category, result, person?} shape the app already renders."""

    def test_no_nominations_is_no_award(self):
        self.assertEqual(pp._oscarbase_award_state([]), (None, "", []))

    def test_a_single_win_is_won(self):
        award, text, detail = pp._oscarbase_award_state(
            [_nom("Directing", "Christopher Nolan", True)])
        self.assertEqual(award, "won")
        self.assertEqual(text, "Won 1 Oscar.")
        self.assertEqual(detail, [{"category": "Directing", "result": "Won",
                                    "person": "Christopher Nolan"}])

    def test_nominations_with_no_win_is_nominated(self):
        award, text, detail = pp._oscarbase_award_state(
            [_nom("Costume Design", "Ellen Mirojnick", False)])
        self.assertEqual(award, "nominated")
        self.assertEqual(text, "Nominated for 1 Oscar.")
        self.assertEqual(detail, [{"category": "Costume Design", "result": "Nominated",
                                    "person": "Ellen Mirojnick"}])

    def test_an_ensemble_win_collapses_to_the_plain_category_line(self):
        # Best Picture's several producers must not surface as several people.
        rows = [_nom("Best Picture", "Emma Thomas", True),
                _nom("Best Picture", "Charles Roven", True),
                _nom("Best Picture", "Christopher Nolan", True)]
        award, text, detail = pp._oscarbase_award_state(rows)
        self.assertEqual(award, "won")
        self.assertEqual(detail, [{"category": "Best Picture", "result": "Won"}])

    def test_award_text_counts_won_categories_not_raw_nomination_rows(self):
        # Oppenheimer: 13 nomination rows across 8 categories, 7 of them Won — the real OMDb
        # count for this film was "Won 7 Oscars", i.e. categories, not rows.
        rows = [
            _nom("Actress In A Supporting Role", "Emily Blunt", False),
            _nom("Directing", "Christopher Nolan", True),
            _nom("Actor In A Leading Role", "Cillian Murphy", True),
            _nom("Actor In A Supporting Role", "Robert Downey Jr.", True),
            _nom("Best Picture", "Emma Thomas", True),
            _nom("Best Picture", "Charles Roven", True),
            _nom("Best Picture", "Christopher Nolan", True),
            _nom("Cinematography", "Hoyte van Hoytema", True),
            _nom("Film Editing", "Jennifer Lame", True),
            _nom("Music (Original Score)", "Ludwig Goransson", True),
            _nom("Production Design", "Ruth De Jong", False),
            _nom("Production Design", "Claire Kaufman", False),
            _nom("Makeup And Hairstyling", "Luisa Abel", False),
        ]
        award, text, detail = pp._oscarbase_award_state(rows)
        self.assertEqual(award, "won")
        self.assertEqual(text, "Won 7 Oscars.")
        self.assertEqual(sum(1 for d in detail if d["result"] == "Won"), 7)


class EnrichOscarbaseWritesTheThreeStates(unittest.TestCase):
    """AC2 — a stubbed OscarBase response proves the three states."""

    def test_a_winning_nomination_writes_won(self):
        movie = {"tmdb_id": 872585}
        listing = _listing([{"id": 7989, "tmdb_id": 872585, "title": "Oppenheimer"}])
        detail = _detail([_nom("Directing", "Christopher Nolan", True)])
        with mock.patch.object(pp, "get_json", side_effect=[listing, detail]), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            pp.enrich_oscarbase(movie, {})
        self.assertEqual(movie["award"], "won")
        self.assertEqual(movie["award_text"], "Won 1 Oscar.")
        self.assertEqual(movie["oscar_detail"],
                         [{"category": "Directing", "result": "Won", "person": "Christopher Nolan"}])

    def test_nominations_with_no_win_writes_nominated(self):
        movie = {"tmdb_id": 42}
        listing = _listing([{"id": 1, "tmdb_id": 42, "title": "Some Film"}])
        detail = _detail([_nom("Costume Design", "A Designer", False)])
        with mock.patch.object(pp, "get_json", side_effect=[listing, detail]), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            pp.enrich_oscarbase(movie, {})
        self.assertEqual(movie["award"], "nominated")

    def test_no_oscarbase_row_leaves_award_absent(self):
        movie = {"tmdb_id": 999999}
        listing = _listing([])   # total: 0 — OscarBase has never heard of this film
        with mock.patch.object(pp, "get_json", return_value=listing), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            pp.enrich_oscarbase(movie, {})
        self.assertNotIn("award", movie)
        self.assertNotIn("award_text", movie)
        self.assertNotIn("oscar_detail", movie)


class OscarbaseJoinsOnTmdbIdOnly(unittest.TestCase):
    """AC3 — the join is on tmdb_id; a same-titled row with a different tmdb_id must not match
    (the Kingdom collision, 2026-09-08)."""

    def test_a_row_with_a_different_tmdb_id_is_rejected(self):
        movie = {"tmdb_id": 111}
        # The list endpoint itself filters exactly by tmdb_id, but this stub simulates a
        # defective/fuzzy answer carrying a row for the wrong film under the same title — the
        # join must reject it by id, never accept it by title.
        listing = _listing([{"id": 42, "tmdb_id": 999, "title": "Kingdom"}])
        with mock.patch.object(pp, "get_json", return_value=listing) as get_json_mock, \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            nominations = pp._oscarbase_lookup_nominations(111)
        self.assertEqual(nominations, [])
        # Only the list call is made — a mismatched row must never trigger the detail fetch.
        get_json_mock.assert_called_once()

    def test_a_matching_tmdb_id_is_accepted(self):
        listing = _listing([{"id": 42, "tmdb_id": 111, "title": "Kingdom"}])
        detail = _detail([_nom("Best Picture", "Someone", True)])
        with mock.patch.object(pp, "get_json", side_effect=[listing, detail]), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            nominations = pp._oscarbase_lookup_nominations(111)
        self.assertEqual(len(nominations), 1)


class NightlyBackfillFallsBackToCacheOnFailure(unittest.TestCase):
    """AC4 — with the fetch raising, the enrichment completes, prints a line starting `[warn]`,
    and still writes the fields from state/oscarbase_cache.json."""

    def test_a_failed_fetch_warns_and_uses_the_cached_row(self):
        today = datetime.date(2026, 9, 12)
        movie = {"tmdb_id": 550, "cinema_date": f"{today.year}-01-01"}   # recent -> needs a fetch
        cache = {"550": {"nominations": [_nom("Best Picture", "Someone", True)],
                          "fetched_at": "2026-01-01"}}

        def boom(*a, **kw):
            raise _http_error(503)

        with mock.patch.object(pp, "get_json", side_effect=boom), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0), \
             mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            outcomes = pp.enrich_oscarbase_awards_nightly([movie], today, cache)

        self.assertTrue(any(line.startswith("[warn]") for line in out.getvalue().splitlines()))
        self.assertEqual(movie["award"], "won")
        self.assertEqual(movie["oscar_detail"],
                         [{"category": "Best Picture", "result": "Won", "person": "Someone"}])
        self.assertEqual(outcomes["cache_fallback"], 1)
        self.assertEqual(outcomes["ok"], 0)

    def test_a_failed_fetch_with_no_cached_row_just_skips(self):
        today = datetime.date(2026, 9, 12)
        movie = {"tmdb_id": 550, "cinema_date": f"{today.year}-01-01"}

        def boom(*a, **kw):
            raise _http_error(503)

        with mock.patch.object(pp, "get_json", side_effect=boom), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            outcomes = pp.enrich_oscarbase_awards_nightly([movie], today, {})
        self.assertNotIn("award", movie)
        self.assertEqual(outcomes["skip"], 1)
        self.assertEqual(outcomes["cache_fallback"], 0)


class OscarbaseNeedsFetch(unittest.TestCase):
    """The refresh policy: fetch a film once, then re-fetch only while its release is within the
    last two ceremony years, plus any film with no cached row at all."""

    def setUp(self):
        self.today = datetime.date(2026, 9, 12)

    def test_an_uncached_title_always_needs_a_fetch(self):
        self.assertTrue(pp._oscarbase_needs_fetch({"tmdb_id": 1, "cinema_date": "2010-01-01"},
                                                   {}, self.today))

    def test_a_cached_old_title_does_not_need_a_refetch(self):
        movie = {"tmdb_id": 1, "cinema_date": "2015-01-01"}
        cache = {"1": {"nominations": [], "fetched_at": "2026-01-01"}}
        self.assertFalse(pp._oscarbase_needs_fetch(movie, cache, self.today))

    def test_a_cached_recent_title_still_needs_a_refetch(self):
        movie = {"tmdb_id": 1, "cinema_date": f"{self.today.year}-01-01"}
        cache = {"1": {"nominations": [], "fetched_at": "2026-01-01"}}
        self.assertTrue(pp._oscarbase_needs_fetch(movie, cache, self.today))

    def test_a_cached_title_with_no_parsable_release_is_left_alone(self):
        movie = {"tmdb_id": 1}
        cache = {"1": {"nominations": [], "fetched_at": "2026-01-01"}}
        self.assertFalse(pp._oscarbase_needs_fetch(movie, cache, self.today))


class NightlyBackfillBudgetAndStop(unittest.TestCase):
    """Bounded, converging backfill: the budget caps calls per run, and a stopping error (a
    rejected/limited answer) halts the rest of this run's candidates."""

    def test_the_backfill_budget_caps_calls_per_run(self):
        today = datetime.date(2026, 9, 12)
        movies = [{"tmdb_id": i, "cinema_date": "2010-01-01"} for i in range(1, 4)]
        with mock.patch.object(pp, "enrich_oscarbase", lambda m, c: m), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            outcomes = pp.enrich_oscarbase_awards_nightly(movies, today, {}, budget=2)
        self.assertEqual(outcomes["ok"], 2)

    def test_a_stopping_error_halts_the_backfill_for_the_rest_of_the_run(self):
        today = datetime.date(2026, 9, 12)
        movies = [{"tmdb_id": i, "cinema_date": "2010-01-01"} for i in range(1, 4)]
        calls = []

        def boom(m, c):
            calls.append(m["tmdb_id"])
            raise _http_error(401, b'{"error":"limited"}')

        with mock.patch.object(pp, "enrich_oscarbase", boom), \
             mock.patch.object(pp, "OSCARBASE_PACING", 0):
            outcomes = pp.enrich_oscarbase_awards_nightly(movies, today, {})
        self.assertEqual(len(calls), 1)
        self.assertEqual(outcomes["stop"], 1)

    def test_an_already_cached_stable_title_is_never_queried(self):
        today = datetime.date(2026, 9, 12)
        movie = {"tmdb_id": 1, "cinema_date": "2010-01-01"}
        cache = {"1": {"nominations": [], "fetched_at": "2026-01-01"}}
        with mock.patch.object(pp, "enrich_oscarbase",
                               side_effect=AssertionError("must not re-query a stable cached title")):
            outcomes = pp.enrich_oscarbase_awards_nightly([movie], today, cache)
        self.assertEqual(outcomes["ok"], 0)
        self.assertEqual(outcomes["skip"], 0)


if __name__ == "__main__":
    unittest.main()
