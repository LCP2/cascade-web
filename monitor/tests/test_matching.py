"""Unit tests for match + de-dupe (CAS-85 / spec 26771457 §5).

Run:  python -m unittest monitor.tests.test_matching   (from the repo root)
"""
import datetime as _dt
import json
import os
import unittest

from monitor import compute_transitions, match, matches_criteria, service_ok, notification_rows
from monitor.catalogue import load_catalogue_file
from monitor.store import InMemoryStore

_HERE = os.path.dirname(os.path.abspath(__file__))
_FIX = os.path.join(os.path.dirname(_HERE), "fixtures")
RUN_DATE = _dt.date(2026, 7, 16)


def _load(name):
    with open(os.path.join(_FIX, name), encoding="utf-8") as fh:
        return json.load(fh)


class _Movie(dict):
    """dict with attribute-free helper; matches use plain dicts anyway."""


class MatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.today = load_catalogue_file(os.path.join(_FIX, "today.json"))
        cls.prev = load_catalogue_file(os.path.join(_FIX, "yesterday.json"))
        cls.transitions = compute_transitions(cls.prev, cls.today, RUN_DATE)
        cls.cascades = _load("cascades.json")

    def _match(self, already=None):
        return match(self.cascades, self.transitions, already=already, catalogue=self.today)

    def _keys(self, by_user):
        return {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                for hits in by_user.values() for h in hits}

    # ---- the right alerts for the right users ----
    def test_matches_expected_hits(self):
        by_user = self._match()
        self.assertEqual(self._keys(by_user), {
            ("cascade-A1", "5001", "hits_rent"),            # Drama rental, imdb 7.2 >= 7
            ("cascade-A2", "5003", "hits_cinema"),          # Action cinema opening
            ("cascade-B1", "5002", "hits_stream"),          # Comedy on Stan (service matches)
            ("cascade-B2", "5004", "past_opening_weekend"), # Thriller, opening + 4
        })
        self.assertEqual(set(by_user), {"user-A", "user-B"})
        self.assertEqual(len(by_user["user-A"]), 2)
        self.assertEqual(len(by_user["user-B"]), 2)

    def test_rating_bar_excludes(self):
        # cascade-A3 wants Drama at imdb>=8; 5001 is 7.2 -> excluded.
        self.assertNotIn(("cascade-A3", "5001", "hits_rent"), self._keys(self._match()))

    def test_inactive_cascade_ignored(self):
        # cascade-A4 is active:false; it would otherwise match 5001.
        self.assertFalse(any(h.cascade_id == "cascade-A4"
                             for hits in self._match().values() for h in hits))

    def test_genre_mismatch_excluded(self):
        # cascade-A5 (Horror) must not catch 5001 (Drama); and 5005 (Horror) is a first-sighting
        # so it produced no transition to match at all.
        keys = self._keys(self._match())
        self.assertFalse(any(cid == "cascade-A5" for cid, _, _ in keys))

    def test_streaming_service_filter(self):
        # cascade-B3 wants Comedy on Netflix; 5002 arrived on Stan -> no hit.
        self.assertNotIn(("cascade-B3", "5002", "hits_stream"), self._keys(self._match()))

    def test_moment_must_be_requested(self):
        # cascade-A1 only asked for hits_rent; it must not fire on cinema/stream moments.
        for hits in self._match().values():
            for h in hits:
                if h.cascade_id == "cascade-A1":
                    self.assertEqual(h.transition.moment, "hits_rent")

    # ---- de-dupe ----
    def test_dedupe_skips_already_sent(self):
        already = {("cascade-A1", "5001", "hits_rent")}
        keys = self._keys(self._match(already=already))
        self.assertNotIn(("cascade-A1", "5001", "hits_rent"), keys)
        self.assertIn(("cascade-A2", "5003", "hits_cinema"), keys)   # others unaffected

    def test_second_run_is_silent(self):
        # Acceptance: a second run with the same catalogue + last run's ledger -> zero alerts.
        first = self._match()
        already = {(h.cascade_id, h.transition.movie_id, h.transition.moment)
                   for hits in first.values() for h in hits}
        second = self._match(already=already)
        self.assertEqual(second, {})

    # ---- ledger rows ----
    def test_notification_rows_shape(self):
        rows = notification_rows(self._match())
        self.assertEqual(len(rows), 4)
        for r in rows:
            self.assertEqual(set(r), {"user_id", "cascade_id", "movie_id", "moment"})

    # ---- store round-trip (in-memory) drives the same de-dupe ----
    def test_inmemory_store_write_then_dedupe(self):
        store = InMemoryStore(cascades=self.cascades, notifications=[])
        active = store.fetch_active_cascades()
        self.assertTrue(all(c.get("active", True) for c in active))
        first = match(active, self.transitions, already=store.fetch_notification_keys(), catalogue=self.today)
        store.insert_notifications(notification_rows(first))
        second = match(active, self.transitions, already=store.fetch_notification_keys(), catalogue=self.today)
        self.assertEqual(second, {})

    # ---- matches_criteria unit cases ----
    def test_matches_criteria_units(self):
        m = {"tmdb_id": 1, "genres": ["Comedy", "Drama"], "age_rating": "PG",
             "language": "en", "imdb_rating": 7.5, "rt_critic": 80, "award": "Won 1 Oscar"}
        self.assertTrue(matches_criteria(m, {"genre": ["Drama"]}))
        self.assertFalse(matches_criteria(m, {"genre": ["Horror"]}))
        self.assertFalse(matches_criteria(m, {"exclude": ["Comedy"]}))       # skip beats match
        self.assertFalse(matches_criteria(m, {"age": ["G"]}))
        self.assertTrue(matches_criteria(m, {"age": ["PG", "M"]}))
        self.assertFalse(matches_criteria(m, {"lang": ["fr"]}))
        self.assertFalse(matches_criteria(m, {"imdb": 8}))
        self.assertTrue(matches_criteria(m, {"imdb": 7}))
        self.assertFalse(matches_criteria(m, {"rt": 90}))
        self.assertTrue(matches_criteria(m, {"awards": True}))
        self.assertFalse(matches_criteria({"tmdb_id": 2, "genres": []}, {"awards": True}))

    def test_include_unrated(self):
        unrated = {"tmdb_id": 3, "genres": ["Drama"], "imdb_rating": 0}
        self.assertFalse(matches_criteria(unrated, {"imdb": 6}))
        self.assertTrue(matches_criteria(unrated, {"imdb": 6, "includeUnrated": True}))

    def test_service_ok_only_constrains_stream(self):
        class T:  # minimal stand-in
            moment = "hits_rent"
            services = []
        self.assertTrue(service_ok(T(), {"services": ["Netflix"]}))   # rent moment: unconstrained


if __name__ == "__main__":
    unittest.main()
