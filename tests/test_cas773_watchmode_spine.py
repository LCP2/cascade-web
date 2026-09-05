"""CAS-773 — v2 phase 1: Watchmode ingest behind a dormant flag, keyed on tmdb_id.

Ingest only (which titles exist, not field mapping). Every test here mocks the network — no
live TMDB/Watchmode/OMDb call is ever made — and CASCADE_SPINE defaults to "tmdb", so the whole
Watchmode path stays provably dormant unless a test explicitly flips it.
"""
import datetime
import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import poc_pipeline as pp


class ParseWatchmodeIdmapCsv(unittest.TestCase):
    """Pure CSV parsing, no network at all — the ID map is just wm_id -> tmdb_id."""

    def test_a_row_with_both_ids_is_kept(self):
        csv_text = "wm_id,tmdb_id,imdb_id\n100,555,tt0000001\n"
        self.assertEqual(pp._parse_watchmode_idmap_csv(csv_text), {"100": 555})

    def test_a_row_missing_tmdb_id_is_dropped(self):
        csv_text = "wm_id,tmdb_id,imdb_id\n100,,tt0000001\n200,777,tt0000002\n"
        self.assertEqual(pp._parse_watchmode_idmap_csv(csv_text), {"200": 777})

    def test_a_non_numeric_tmdb_id_is_dropped_not_raised(self):
        csv_text = "wm_id,tmdb_id\n100,not-a-number\n"
        self.assertEqual(pp._parse_watchmode_idmap_csv(csv_text), {})


class IngestWatchmode(unittest.TestCase):
    """AC3 — stubbed HTTP layer + stubbed ID map: a title with a tmdb_id is ingested and keyed
    on it; a title without one is skipped and counted; the ID map is fetched once per run, not
    per title. No live API call anywhere in this class."""

    def test_a_title_with_a_tmdb_id_is_ingested_and_keyed_on_it(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={"100": 555}), \
             mock.patch.object(pp, "_list_watchmode_titles_page",
                               return_value={"titles": [{"id": 100, "title": "Film A",
                                                          "year": 2026, "imdb_id": "tt1"}],
                                              "page": 1, "total_pages": 1}):
            movies = pp.ingest_watchmode(set())
        self.assertEqual(len(movies), 1)
        self.assertEqual(movies[0]["tmdb_id"], 555)
        self.assertEqual(movies[0]["title"], "Film A")

    def test_a_title_with_no_tmdb_id_is_skipped_and_counted(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={"100": 555}), \
             mock.patch.object(pp, "_list_watchmode_titles_page",
                               return_value={"titles": [
                                   {"id": 100, "title": "Film A", "year": 2026},
                                   {"id": 999, "title": "No TMDB match", "year": 2026},
                               ], "page": 1, "total_pages": 1}):
            out = io.StringIO()
            with redirect_stdout(out):
                movies = pp.ingest_watchmode(set())
        self.assertEqual(len(movies), 1, "only the resolvable title should be ingested")
        self.assertIn("skipped 1", out.getvalue())

    def test_the_id_map_is_fetched_once_per_run_not_per_title(self):
        idmap_calls = {"n": 0}

        def fake_idmap():
            idmap_calls["n"] += 1
            return {"100": 555, "101": 556, "102": 557}

        with mock.patch.object(pp, "_fetch_watchmode_idmap", side_effect=fake_idmap), \
             mock.patch.object(pp, "_list_watchmode_titles_page",
                               return_value={"titles": [
                                   {"id": 100, "title": "Film A", "year": 2026},
                                   {"id": 101, "title": "Film B", "year": 2026},
                                   {"id": 102, "title": "Film C", "year": 2026},
                               ], "page": 1, "total_pages": 1}):
            movies = pp.ingest_watchmode(set())
        self.assertEqual(len(movies), 3)
        self.assertEqual(idmap_calls["n"], 1, "the ID map must be fetched once, not per title")

    def test_a_tmdb_id_already_in_seen_is_not_re_ingested(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap", return_value={"100": 555}), \
             mock.patch.object(pp, "_list_watchmode_titles_page",
                               return_value={"titles": [{"id": 100, "title": "Film A", "year": 2026}],
                                              "page": 1, "total_pages": 1}):
            movies = pp.ingest_watchmode({555})
        self.assertEqual(movies, [])

    def test_an_unavailable_id_map_yields_no_titles_not_an_error(self):
        with mock.patch.object(pp, "_fetch_watchmode_idmap",
                               side_effect=RuntimeError("Watchmode: invalid api key")), \
             mock.patch.object(pp, "_list_watchmode_titles_page",
                               side_effect=AssertionError("must not list titles without an id map")):
            movies = pp.ingest_watchmode(set())
        self.assertEqual(movies, [])


class CascadeSpineGatesTheIngestPath(unittest.TestCase):
    """AC4 — with CASCADE_SPINE=tmdb (the default), the Watchmode ingest path is never entered."""

    def setUp(self):
        self.today = datetime.date(2026, 9, 5)
        prov = {"jw_link": "https://jw/x", "rows": {}}
        patches = [
            mock.patch.object(pp, "ingest_tmdb", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "tmdb_providers", lambda tid: prov),
            mock.patch.object(pp, "has_provider_rows", lambda p: False),
            mock.patch.object(pp, "enrich_omdb", lambda m: m),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_with_cascade_spine_tmdb_the_watchmode_ingest_path_is_never_entered(self):
        with mock.patch.object(pp, "CASCADE_SPINE", "tmdb"), \
             mock.patch.object(pp, "ingest_watchmode",
                               side_effect=AssertionError("watchmode ingest must not run when "
                                                          "CASCADE_SPINE is tmdb")):
            pp.build_live_catalogue(self.today, [], {}, ondemand_ids=[])

    def test_with_cascade_spine_watchmode_the_tmdb_ingest_path_is_not_entered(self):
        with mock.patch.object(pp, "CASCADE_SPINE", "watchmode"), \
             mock.patch.object(pp, "ingest_watchmode", lambda seen: []), \
             mock.patch.object(pp, "ingest_tmdb",
                               side_effect=AssertionError("tmdb ingest must not run when "
                                                          "CASCADE_SPINE is watchmode")):
            pp.build_live_catalogue(self.today, [], {}, ondemand_ids=[])

    def test_cascade_spine_defaults_to_tmdb(self):
        import os
        self.assertNotIn("CASCADE_SPINE", os.environ,
                        "this test's assumption breaks if the harness sets CASCADE_SPINE")
        self.assertEqual(pp.CASCADE_SPINE, "tmdb")


if __name__ == "__main__":
    unittest.main()
