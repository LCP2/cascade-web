"""CAS-772 — cache TTL / revalidation / purge: the data-licensing precondition for paying for
Watchmode. Watchmode's terms cap cached data at 30 days and require deleting it all on
cancellation; TMDB's terms cap it at 6 months and require the same on termination. This is the
single, provider-agnostic mechanism for both — see poc_pipeline.py's CAS-772 section.
"""
import datetime
import inspect
import os
import tempfile
import unittest
from unittest import mock

import poc_pipeline as pp


class CacheAgeAndTtlSelection(unittest.TestCase):
    """AC1 — a stubbed clock proves a record older than the TTL is selected for revalidation
    and one inside it is not. `today` is passed in directly, so no real-clock patching is
    needed; that IS the stub."""

    def test_a_record_older_than_the_ttl_needs_revalidation(self):
        today = datetime.date(2026, 9, 5)
        stamped = (today - datetime.timedelta(days=pp.CACHE_TTL_DAYS + 1)).isoformat()
        m = {"tmdb_id": 1, "cache_stamped_at": stamped}
        self.assertTrue(pp.needs_revalidation(m, today))

    def test_a_record_inside_the_ttl_does_not_need_revalidation(self):
        today = datetime.date(2026, 9, 5)
        stamped = (today - datetime.timedelta(days=pp.CACHE_TTL_DAYS - 1)).isoformat()
        m = {"tmdb_id": 2, "cache_stamped_at": stamped}
        self.assertFalse(pp.needs_revalidation(m, today))

    def test_a_record_at_exactly_the_ttl_needs_revalidation(self):
        today = datetime.date(2026, 9, 5)
        stamped = (today - datetime.timedelta(days=pp.CACHE_TTL_DAYS)).isoformat()
        m = {"tmdb_id": 3, "cache_stamped_at": stamped}
        self.assertTrue(pp.needs_revalidation(m, today))

    def test_a_record_never_stamped_needs_revalidation(self):
        """A base record from before CAS-772 has no cache_stamped_at at all — unknown age is
        never treated as fresh."""
        today = datetime.date(2026, 9, 5)
        self.assertTrue(pp.needs_revalidation({"tmdb_id": 4}, today))

    def test_the_ttl_is_the_shorter_of_the_two_vendor_limits(self):
        self.assertEqual(pp.CACHE_TTL_DAYS, pp.WATCHMODE_CACHE_TTL_DAYS)
        self.assertLess(pp.CACHE_TTL_DAYS, pp.TMDB_CACHE_TTL_DAYS)

    def test_select_revalidation_candidates_picks_stale_over_fresh(self):
        today = datetime.date(2026, 9, 5)
        stale = {"tmdb_id": 1, "cache_stamped_at": (today - datetime.timedelta(days=40)).isoformat()}
        fresh = {"tmdb_id": 2, "cache_stamped_at": (today - datetime.timedelta(days=1)).isoformat()}
        got = pp.select_revalidation_candidates([stale, fresh], today)
        self.assertEqual([m["tmdb_id"] for m in got], [1])

    def test_the_daily_budget_caps_how_many_are_selected_per_run(self):
        today = datetime.date(2026, 9, 5)
        catalogue = [{"tmdb_id": i, "cache_stamped_at": (today - datetime.timedelta(days=40)).isoformat()}
                     for i in range(1, 6)]
        got = pp.select_revalidation_candidates(catalogue, today, budget=2)
        self.assertEqual(len(got), 2)

    def test_oldest_stale_records_go_first(self):
        today = datetime.date(2026, 9, 5)
        older = {"tmdb_id": 1, "cache_stamped_at": (today - datetime.timedelta(days=90)).isoformat()}
        newer_stale = {"tmdb_id": 2, "cache_stamped_at": (today - datetime.timedelta(days=31)).isoformat()}
        got = pp.select_revalidation_candidates([newer_stale, older], today, budget=1)
        self.assertEqual(got[0]["tmdb_id"], 1, "the least-recently-confirmed record must be revalidated first")

    def test_unstamped_records_are_prioritised_over_merely_expired_ones(self):
        today = datetime.date(2026, 9, 5)
        expired = {"tmdb_id": 1, "cache_stamped_at": (today - datetime.timedelta(days=31)).isoformat()}
        never_stamped = {"tmdb_id": 2}
        got = pp.select_revalidation_candidates([expired, never_stamped], today, budget=1)
        self.assertEqual(got[0]["tmdb_id"], 2)


class CacheHealthStats(unittest.TestCase):
    """AC3 groundwork — the three cache-health numbers the daily run must log."""

    def test_oldest_age_and_over_ttl_count(self):
        today = datetime.date(2026, 9, 5)
        catalogue = [
            {"tmdb_id": 1, "cache_stamped_at": (today - datetime.timedelta(days=5)).isoformat()},
            {"tmdb_id": 2, "cache_stamped_at": (today - datetime.timedelta(days=40)).isoformat()},
            {"tmdb_id": 3, "cache_stamped_at": (today - datetime.timedelta(days=90)).isoformat()},
        ]
        oldest, over_ttl = pp.cache_health_stats(catalogue, today)
        self.assertEqual(oldest, 90)
        self.assertEqual(over_ttl, 2)

    def test_unstamped_records_count_toward_over_ttl_but_not_oldest(self):
        today = datetime.date(2026, 9, 5)
        catalogue = [{"tmdb_id": 1}, {"tmdb_id": 2, "cache_stamped_at": today.isoformat()}]
        oldest, over_ttl = pp.cache_health_stats(catalogue, today)
        self.assertEqual(oldest, 0)
        self.assertEqual(over_ttl, 1)

    def test_an_empty_catalogue_reports_no_known_age(self):
        today = datetime.date(2026, 9, 5)
        oldest, over_ttl = pp.cache_health_stats([], today)
        self.assertIsNone(oldest)
        self.assertEqual(over_ttl, 0)


class RevalidateRecordRefreshesVendorFieldsOnly(unittest.TestCase):
    """revalidate_record must restamp cache_stamped_at and refresh vendor-content fields, but
    never touch availability (offers/status/last_polled) — that is a separate, daily poll."""

    def test_the_stamp_and_vendor_fields_update_without_touching_availability(self):
        today = datetime.date(2026, 9, 5)
        m = {"tmdb_id": 1, "title": "Old Title", "offers": [{"service": "Netflix"}],
             "status": ["included_streaming"], "last_polled": "2026-08-01"}
        detail = {"id": 1, "imdb_id": "tt0000001", "title": "New Title", "release_date": "2026-01-01",
                  "genres": [], "production_countries": [], "original_language": "en",
                  "release_dates": {"results": []}, "videos": {"results": []},
                  "credits": {"cast": [], "crew": []}}
        with mock.patch.object(pp, "get_json", return_value=detail):
            pp.revalidate_record(m, today)
        self.assertEqual(m["title"], "New Title")
        self.assertEqual(m["cache_stamped_at"], today.isoformat())
        self.assertEqual(m["offers"], [{"service": "Netflix"}])
        self.assertEqual(m["status"], ["included_streaming"])
        self.assertEqual(m["last_polled"], "2026-08-01")


class RevalidationSweepDuringBuild(unittest.TestCase):
    """The sweep is wired into build_live_catalogue, spending its own bounded budget like every
    other backfill in that function."""

    def setUp(self):
        self.today = datetime.date(2026, 9, 5)
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
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def _title(self, tmdb_id, cache_stamped_at):
        return {"tmdb_id": tmdb_id, "imdb_id": f"tt{tmdb_id:07d}", "title": f"Film {tmdb_id}",
                "cinema_date": "2025-01-01", "popularity": 10.0, "cinema_release": True,
                "cache_stamped_at": cache_stamped_at}

    def test_a_stale_record_gets_revalidated_and_restamped(self):
        stale = self._title(1, (self.today - datetime.timedelta(days=40)).isoformat())
        with mock.patch.object(pp, "revalidate_record",
                               lambda m, t: m.update(cache_stamped_at=t.isoformat()) or m):
            catalogue, counts = pp.build_live_catalogue(self.today, [stale], {}, ondemand_ids=[])
        self.assertEqual(counts["revalidated"], 1)
        self.assertEqual(catalogue[0]["cache_stamped_at"], self.today.isoformat())

    def test_a_fresh_record_is_left_alone(self):
        fresh = self._title(1, self.today.isoformat())
        with mock.patch.object(pp, "revalidate_record",
                               side_effect=AssertionError("must not revalidate a fresh record")):
            catalogue, counts = pp.build_live_catalogue(self.today, [fresh], {}, ondemand_ids=[])
        self.assertEqual(counts["revalidated"], 0)

    def test_the_revalidation_budget_caps_calls_per_run(self):
        stale = [self._title(i, (self.today - datetime.timedelta(days=40)).isoformat()) for i in range(1, 4)]
        with mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 2), \
             mock.patch.object(pp, "revalidate_record",
                               lambda m, t: m.update(cache_stamped_at=t.isoformat()) or m):
            catalogue, counts = pp.build_live_catalogue(self.today, stale, {}, ondemand_ids=[])
        self.assertEqual(counts["revalidated"], 2)


class PurgeVendorCacheRemovesVendorContentOnly(unittest.TestCase):
    """AC2 — the purge entry point removes vendor-derived cached content and leaves user-owned
    data alone, and is never reachable from a scheduled run."""

    def test_purge_removes_named_vendor_files_and_leaves_others_alone(self):
        with tempfile.TemporaryDirectory() as d:
            vendor_a = os.path.join(d, "movies.json")
            vendor_b = os.path.join(d, "last_snapshot.json")
            user_owned = os.path.join(d, "ondemand.json")   # which titles USERS engaged with
            for p in (vendor_a, vendor_b, user_owned):
                with open(p, "w") as f:
                    f.write("{}")
            removed = pp.purge_vendor_cache([vendor_a, vendor_b])
            self.assertEqual(set(removed), {vendor_a, vendor_b})
            self.assertFalse(os.path.exists(vendor_a))
            self.assertFalse(os.path.exists(vendor_b))
            self.assertTrue(os.path.exists(user_owned),
                            "purge must not touch data outside the vendor-cache list")

    def test_a_missing_file_is_skipped_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            missing = os.path.join(d, "does-not-exist.json")
            self.assertEqual(pp.purge_vendor_cache([missing]), [])

    def test_the_default_vendor_cache_list_excludes_user_data_and_our_own_counters(self):
        """ondemand.json (which titles users engaged with) and api_budget.json (our own spend
        counters, not vendor content) must never be in the purge's default scope."""
        names = {os.path.basename(p) for p in pp.VENDOR_CACHE_FILES}
        self.assertNotIn("ondemand.json", names)
        self.assertNotIn("api_budget.json", names)

    def test_purge_is_not_reachable_from_run_or_build_live_catalogue(self):
        """Purge is a deliberate, human-triggered action for cancellation, never wired into any
        scheduled job — assert it statically rather than trusting nobody adds a call later."""
        for fn in (pp.run, pp.build_live_catalogue):
            src = inspect.getsource(fn)
            self.assertNotIn("purge_vendor_cache", src,
                             f"{fn.__name__} must never call purge_vendor_cache — it is human-triggered only")

    def test_the_daily_scheduled_workflow_never_passes_the_purge_flag(self):
        workflow = os.path.join(os.path.dirname(__file__), "..", ".github", "workflows", "daily.yml")
        with open(workflow, encoding="utf-8") as f:
            content = f.read()
        self.assertNotIn("--purge-vendor-cache", content)


if __name__ == "__main__":
    unittest.main()
