"""CAS-986: fetch_user_held_ids() — the two-tier catalogue's demotion-safety net. Every tmdb_id a
user holds state on, across four tables, as a set of strings ready to be sorted straight into
state/user_held_ids.json.

Run:  python -m unittest monitor.tests.test_store   (from the repo root)
"""
import unittest

from monitor.store import InMemoryStore


class FetchUserHeldIds(unittest.TestCase):
    def test_the_union_covers_all_four_tables(self):
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "liked"}],
            watches=[{"user_id": "u1", "movie_id": 222, "windows": ["rental"]}],
            agent_films=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 333}],
            notifications=[{"user_id": "u1", "cascade_id": "c1", "movie_id": 444, "moment": "arrived"}],
        )
        self.assertEqual(store.fetch_user_held_ids(), {"111", "222", "333", "444"})

    def test_a_shared_id_across_tables_is_not_duplicated(self):
        store = InMemoryStore(
            user_films=[{"user_id": "u1", "movie_id": 111, "status": "liked"}],
            agent_films=[{"user_id": "u2", "cascade_id": "c1", "movie_id": 111}],
        )
        self.assertEqual(store.fetch_user_held_ids(), {"111"})

    def test_ids_are_returned_as_strings_regardless_of_source_type(self):
        store = InMemoryStore(user_films=[{"user_id": "u1", "movie_id": "999", "status": "liked"}],
                              watches=[{"user_id": "u1", "movie_id": 999, "windows": []}])
        self.assertEqual(store.fetch_user_held_ids(), {"999"})

    def test_a_row_with_no_movie_id_is_ignored_not_stringified_to_none(self):
        store = InMemoryStore(notifications=[{"user_id": "u1", "cascade_id": None, "moment": "x"}])
        self.assertEqual(store.fetch_user_held_ids(), set())

    def test_nothing_held_anywhere_is_an_empty_set_not_an_error(self):
        store = InMemoryStore()
        self.assertEqual(store.fetch_user_held_ids(), set())


if __name__ == "__main__":
    unittest.main()
