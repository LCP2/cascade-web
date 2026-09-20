"""CAS-1046 — state/refresh_log.json: a per-run history of what the daily refresh brought in
(new/removed/updated films by source, status and age), for the admin site
(cascade-admin.pages.dev, a separate repo) to read. Everything here is the pure counting
function (build_refresh_log_entry) plus the append/cap/recovery wrapper (append_refresh_log) —
no network, no real state/ file is ever touched.
"""
import datetime
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


def _run_at():
    return datetime.datetime(2026, 9, 20, 3, 15, 0, tzinfo=datetime.timezone.utc)


class RefreshLogCounting(unittest.TestCase):
    """AC1 — exact values for new/removed/updated/unchanged, every new_by_status and
    new_by_age bucket, one status_changes key, and that a last_polled-only change does NOT
    count as updated."""

    def setUp(self):
        self.prev = [
            {"tmdb_id": 1, "title": "Unchanged", "status": ["in_cinema"],
             "popularity": 10.0, "last_polled": "2026-09-19"},
            {"tmdb_id": 2, "title": "Bookkeeping only", "status": ["in_cinema"],
             "popularity": 5.0, "last_polled": "2026-09-19", "cache_stamped_at": "2026-09-19",
             "poll_tier": "active"},
            {"tmdb_id": 3, "title": "Real field change", "status": ["in_cinema"],
             "popularity": 5.0, "last_polled": "2026-09-19"},
            {"tmdb_id": 4, "title": "Status changes", "status": ["in_cinema"],
             "popularity": 5.0, "last_polled": "2026-09-19"},
            {"tmdb_id": 5, "title": "Removed", "status": ["in_cinema"], "last_polled": "2026-09-19"},
        ]
        self.today = [
            {"tmdb_id": 1, "title": "Unchanged", "status": ["in_cinema"],
             "popularity": 10.0, "last_polled": "2026-09-20"},   # last_polled always moves; ignored
            {"tmdb_id": 2, "title": "Bookkeeping only", "status": ["in_cinema"],
             "popularity": 5.0, "last_polled": "2026-09-20", "cache_stamped_at": "2026-09-20",
             "poll_tier": "passive"},
            {"tmdb_id": 3, "title": "Real field change", "status": ["in_cinema"],
             "popularity": 9.0, "last_polled": "2026-09-20"},
            {"tmdb_id": 4, "title": "Status changes", "status": ["included_streaming"],
             "popularity": 5.0, "last_polled": "2026-09-20"},
            # new: one per status bucket (+ "other"), ages spread across every bucket
            {"tmdb_id": 10, "title": "New upcoming", "status": ["upcoming"],
             "cinema_date": "2027-03-01"},                                    # unreleased
            {"tmdb_id": 11, "title": "New in_cinema", "status": ["in_cinema"],
             "cinema_date": "2026-08-01"},                                    # under_1y
            {"tmdb_id": 12, "title": "New pvod", "status": ["pvod"],
             "cinema_date": "2024-09-20"},                                    # 1_to_5y
            {"tmdb_id": 13, "title": "New rental", "status": ["rental"],
             "cinema_date": "2015-01-01"},                                    # 5_to_20y
            {"tmdb_id": 14, "title": "New included_streaming", "status": ["included_streaming"],
             "cinema_date": "1990-01-01"},                                    # over_20y
            {"tmdb_id": 15, "title": "New released", "status": ["released"]},  # unknown (no date/year)
            {"tmdb_id": 16, "title": "New weird status", "status": ["withdrawn"],
             "cinema_date": "2020-01-01"},                                    # other / 5_to_20y
        ]
        self.run_stats = {"date": "2026-09-20",
                           "tmdb": {"calls": 100, "errors": 1, "not_found": 2},
                           "watchmode": {"calls": 20, "errors": 0},
                           "oscarbase": {"calls": 30, "errors": 0}}
        self.entry = pp.build_refresh_log_entry(self.prev, self.today, self.run_stats, _run_at())

    def test_catalogue_counts(self):
        self.assertEqual(self.entry["catalogue"], {
            "before": 5, "after": 11, "new": 7, "removed": 1, "updated": 2, "unchanged": 2,
        })

    def test_bookkeeping_only_change_is_unchanged_not_updated(self):
        # id 2 only moved last_polled/cache_stamped_at/poll_tier — must land in "unchanged".
        self.assertEqual(self.entry["catalogue"]["updated"], 2)

    def test_new_by_status_every_bucket(self):
        self.assertEqual(self.entry["new_by_status"], {
            "upcoming": 1, "in_cinema": 1, "pvod": 1, "rental": 1,
            "included_streaming": 1, "released": 1, "other": 1,
        })

    def test_new_by_age_every_bucket(self):
        self.assertEqual(self.entry["new_by_age"], {
            "unreleased": 1, "under_1y": 1, "1_to_5y": 1,
            "5_to_20y": 2, "over_20y": 1, "unknown": 1,
        })

    def test_one_status_change_key(self):
        self.assertEqual(self.entry["status_changes"], {"in_cinema->included_streaming": 1})

    def test_run_stats_calls_errors_not_found_pass_through(self):
        self.assertEqual(self.entry["sources"]["tmdb"]["calls"], 100)
        self.assertEqual(self.entry["sources"]["tmdb"]["errors"], 1)
        self.assertEqual(self.entry["sources"]["tmdb"]["not_found"], 2)
        self.assertEqual(self.entry["sources"]["watchmode"]["calls"], 20)
        self.assertEqual(self.entry["sources"]["oscarbase"]["calls"], 30)
        self.assertNotIn("not_found", self.entry["sources"]["watchmode"])
        self.assertNotIn("films_new", self.entry["sources"]["oscarbase"])

    def test_run_at_and_run_date(self):
        self.assertEqual(self.entry["run_date"], "2026-09-20")
        self.assertEqual(self.entry["run_at"], "2026-09-20T03:15:00Z")


class RefreshLogSourceAttribution(unittest.TestCase):
    """Per-source films_new/films_updated: a title may count for more than one source; offers/
    status changes are TMDB's unless this title's availability_source is watchmode_enriched."""

    def test_watchmode_field_change_counts_for_watchmode_only(self):
        prev = [{"tmdb_id": 1, "status": ["in_cinema"], "wm_user_rating": 6.0}]
        today = [{"tmdb_id": 1, "status": ["in_cinema"], "wm_user_rating": 7.5}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["sources"]["watchmode"]["films_updated"], 1)
        self.assertEqual(entry["sources"]["tmdb"]["films_updated"], 0)

    def test_oscarbase_field_change_counts_for_oscarbase_only(self):
        prev = [{"tmdb_id": 1, "status": ["in_cinema"], "award": None}]
        today = [{"tmdb_id": 1, "status": ["in_cinema"], "award": "winner"}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["sources"]["oscarbase"]["films_updated"], 1)
        self.assertEqual(entry["sources"]["tmdb"]["films_updated"], 0)

    def test_offers_change_is_tmdb_when_not_watchmode_enriched(self):
        prev = [{"tmdb_id": 1, "status": ["in_cinema"], "offers": [],
                  "availability_source": "tmdb_providers"}]
        today = [{"tmdb_id": 1, "status": ["in_cinema"],
                   "offers": [{"service": "Netflix"}], "availability_source": "tmdb_providers"}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["sources"]["tmdb"]["films_updated"], 1)
        self.assertEqual(entry["sources"]["watchmode"]["films_updated"], 0)

    def test_offers_change_is_watchmode_when_watchmode_enriched(self):
        prev = [{"tmdb_id": 1, "status": ["in_cinema"], "offers": [],
                  "availability_source": "watchmode_enriched"}]
        today = [{"tmdb_id": 1, "status": ["in_cinema"],
                   "offers": [{"service": "Netflix"}], "availability_source": "watchmode_enriched"}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["sources"]["watchmode"]["films_updated"], 1)
        self.assertEqual(entry["sources"]["tmdb"]["films_updated"], 0)

    def test_a_title_can_count_for_more_than_one_source(self):
        prev = [{"tmdb_id": 1, "status": ["in_cinema"], "popularity": 1.0, "award": None}]
        today = [{"tmdb_id": 1, "status": ["in_cinema"], "popularity": 2.0, "award": "winner"}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["sources"]["tmdb"]["films_updated"], 1)
        self.assertEqual(entry["sources"]["oscarbase"]["films_updated"], 1)

    def test_films_new_attributed_by_availability_source(self):
        today = [
            {"tmdb_id": 1, "status": ["in_cinema"], "availability_source": "tmdb_providers"},
            {"tmdb_id": 2, "status": ["in_cinema"], "availability_source": "watchmode_enriched"},
        ]
        entry = pp.build_refresh_log_entry([], today, {}, _run_at())
        self.assertEqual(entry["sources"]["tmdb"]["films_new"], 1)
        self.assertEqual(entry["sources"]["watchmode"]["films_new"], 1)
        self.assertTrue(entry["notes"])   # discloses the attribution method used

    def test_no_notes_when_nothing_new(self):
        prev = today = [{"tmdb_id": 1, "status": ["in_cinema"]}]
        entry = pp.build_refresh_log_entry(prev, today, {}, _run_at())
        self.assertEqual(entry["notes"], [])

    def test_github_run_id_passes_through(self):
        entry = pp.build_refresh_log_entry([], [], {}, _run_at(), github_run_id="12345")
        self.assertEqual(entry["github_run_id"], "12345")

    def test_github_run_id_defaults_to_none(self):
        entry = pp.build_refresh_log_entry([], [], {}, _run_at())
        self.assertIsNone(entry["github_run_id"])


class RefreshLogAppendCap(unittest.TestCase):
    """AC2 — appending to a log already holding 120 entries leaves 120, newest first."""

    def test_cap_holds_120_with_newest_first(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "refresh_log.json")
            with mock.patch.object(pp, "REFRESH_LOG_FILE", path), \
                 mock.patch.object(pp, "STATE_DIR", d):
                for i in range(120):
                    pp.append_refresh_log({"run_at": f"run-{i}"})
                pp.append_refresh_log({"run_at": "newest"})
                data = pp._load_refresh_log()
                self.assertEqual(len(data["runs"]), 120)
                self.assertEqual(data["runs"][0]["run_at"], "newest")
                self.assertEqual(data["runs"][-1]["run_at"], "run-1")   # run-0 fell off the cap


class RefreshLogCorruptRecovery(unittest.TestCase):
    """AC3 — a missing or corrupt state/refresh_log.json is replaced with a valid one-entry
    file, and the append itself must not raise."""

    def test_missing_file_becomes_one_entry(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "refresh_log.json")
            with mock.patch.object(pp, "REFRESH_LOG_FILE", path), \
                 mock.patch.object(pp, "STATE_DIR", d):
                pp.append_refresh_log({"run_at": "only"})
                data = pp._load_refresh_log()
                self.assertEqual(len(data["runs"]), 1)
                self.assertEqual(data["runs"][0]["run_at"], "only")

    def test_corrupt_json_is_replaced_not_fatal(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "refresh_log.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{not valid json")
            with mock.patch.object(pp, "REFRESH_LOG_FILE", path), \
                 mock.patch.object(pp, "STATE_DIR", d):
                pp.append_refresh_log({"run_at": "recovered"})   # must not raise
                data = pp._load_refresh_log()
                self.assertEqual(len(data["runs"]), 1)
                self.assertEqual(data["runs"][0]["run_at"], "recovered")

    def test_wrong_shape_is_replaced_not_fatal(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "refresh_log.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write('{"unexpected": "shape"}')
            with mock.patch.object(pp, "REFRESH_LOG_FILE", path), \
                 mock.patch.object(pp, "STATE_DIR", d):
                pp.append_refresh_log({"run_at": "recovered"})
                data = pp._load_refresh_log()
                self.assertEqual(len(data["runs"]), 1)


if __name__ == "__main__":
    unittest.main()
