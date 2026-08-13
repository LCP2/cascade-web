"""CAS-486: the on-demand notification test harness.

Covers the three things that actually make "intense test cycles" safe and possible:
  - target_user fails closed (no default that resolves to "everyone")
  - the fixture file's own id range / marker are enforced before anything is built from it
  - build_catalogues fires exactly the requested scenario's transition, nothing else
  - the cleanup DELETE is scoped strictly to the reserved fixture id range, never wider
"""
import json
import os
import tempfile
import unittest

from monitor import compute_transitions
from monitor.notify_test import (DEFAULT_FIXTURES, FIXTURE_MARKER, build_catalogues,
                                  load_fixture_films, validate_target_user)
from monitor.store import FIXTURE_ID_MAX, FIXTURE_ID_MIN, InMemoryStore


class TargetUserFailsClosed(unittest.TestCase):
    def test_empty_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user("")

    def test_none_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user(None)

    def test_not_a_uuid_is_refused(self):
        with self.assertRaises(SystemExit):
            validate_target_user("everyone")

    def test_a_real_uuid_is_accepted(self):
        uid = "5ef56b23-cdec-5c0a-af6d-3bea00000000"
        self.assertEqual(validate_target_user(uid), uid)


class FixtureFileGuardrails(unittest.TestCase):
    def test_the_real_fixture_file_loads_and_covers_every_scenario(self):
        films = load_fixture_films(DEFAULT_FIXTURES)
        scenarios = {f["scenario"] for f in films}
        self.assertEqual(scenarios, {"announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream"})
        for f in films:
            self.assertTrue(FIXTURE_ID_MIN <= f["tmdb_id"] <= FIXTURE_ID_MAX)
            self.assertEqual(f["director"], FIXTURE_MARKER)

    def _write(self, films):
        fh = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump({"films": films}, fh)
        fh.close()
        return fh.name

    def test_an_id_outside_the_reserved_range_is_refused(self):
        path = self._write([{"tmdb_id": 12345, "scenario": "announced", "director": FIXTURE_MARKER,
                              "today_status": ["upcoming"], "yesterday_present": False,
                              "yesterday_status": []}])
        try:
            with self.assertRaises(ValueError):
                load_fixture_films(path)
        finally:
            os.unlink(path)

    def test_a_missing_marker_is_refused(self):
        path = self._write([{"tmdb_id": 999000001, "scenario": "announced", "director": "Someone Real",
                              "today_status": ["upcoming"], "yesterday_present": False,
                              "yesterday_status": []}])
        try:
            with self.assertRaises(ValueError):
                load_fixture_films(path)
        finally:
            os.unlink(path)


class BuildCatalogues(unittest.TestCase):
    def setUp(self):
        self.films = load_fixture_films(DEFAULT_FIXTURES)

    def test_unknown_scenario_raises(self):
        with self.assertRaises(ValueError):
            build_catalogues(self.films, "not_a_real_scenario", "2026-08-13")

    def test_announced_film_is_absent_yesterday_present_today(self):
        yesterday, today = build_catalogues(self.films, "announced", "2026-08-13")
        self.assertNotIn(999000001, [m["tmdb_id"] for m in yesterday])
        self.assertIn(999000001, [m["tmdb_id"] for m in today])

    def test_exactly_the_chosen_scenario_transitions_and_nothing_else(self):
        for scenario in ("announced", "hits_cinema", "hits_pvod", "hits_rent", "hits_stream"):
            with self.subTest(scenario=scenario):
                yesterday, today = build_catalogues(self.films, scenario, "2026-08-13")
                transitions = compute_transitions(yesterday, today, __import__("datetime").date(2026, 8, 13))
                fired = {(t.movie_id, t.moment) for t in transitions
                         if int(t.movie_id) >= FIXTURE_ID_MIN}
                target = next(f for f in self.films if f["scenario"] == scenario)
                self.assertIn((str(target["tmdb_id"]), scenario), fired)
                # every other fixture film holds its own today-state on both days, so it must not
                # also produce a transition just from being present in this catalogue pair.
                others = {(t.movie_id, t.moment) for t in transitions
                          if int(t.movie_id) >= FIXTURE_ID_MIN and t.movie_id != str(target["tmdb_id"])}
                self.assertEqual(others, set())


class CleanupScope(unittest.TestCase):
    def test_only_fixture_range_ids_are_removed(self):
        store = InMemoryStore(notifications=[
            {"cascade_id": "c1", "movie_id": "999000001", "moment": "announced"},
            {"cascade_id": "c2", "movie_id": "999000002", "moment": "hits_cinema"},
            {"cascade_id": "c3", "movie_id": "42", "moment": "hits_rent"},   # a real movie — must survive
        ])
        removed = store.delete_notifications_for_movie_ids(["999000001", "999000002", "42", "not-a-number"])
        self.assertEqual(removed, 2)
        remaining = {movie_id for (_cascade_id, movie_id, _moment) in store.fetch_notification_keys()}
        self.assertEqual(remaining, {"42"})

    def test_a_malicious_or_malformed_id_can_only_shrink_the_set_never_widen_it(self):
        store = InMemoryStore(notifications=[{"cascade_id": "c1", "movie_id": "42", "moment": "hits_rent"}])
        removed = store.delete_notifications_for_movie_ids(["42", "'; drop table notifications; --", None, ""])
        self.assertEqual(removed, 0)


if __name__ == "__main__":
    unittest.main()
