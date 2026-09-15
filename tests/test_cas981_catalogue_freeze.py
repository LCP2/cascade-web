"""CAS-981 — discovery must run on every refresh, not only while len(base) < CATALOGUE_TARGET.

The old guard (`if len(base) < CATALOGUE_TARGET:`) froze the catalogue permanently the first run
it reached the cap: ingest_tmdb/ingest_tmdb_upcoming/ingest_tmdb_streaming stopped being called,
so no new release could ever enter and no stale title could ever be displaced. The popularity
sort + slice a few lines below already enforces the cap on its own and needs no help — this test
proves discovery runs even when the base is already AT the cap, and that a higher-popularity
arrival still displaces the lowest-popularity incumbent.
"""
import datetime
import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

import poc_pipeline as pp


def _rec(tmdb_id, popularity):
    return {"tmdb_id": tmdb_id, "popularity": popularity, "status": ["upcoming"],
            "cinema_release": None}


class DiscoveryRunsRegardlessOfCatalogueSize(unittest.TestCase):
    def setUp(self):
        self.today = datetime.date(2026, 9, 15)
        # 6,000 base records already AT the cap, popularity 6000 down to 1 — the bottom 10
        # (popularity 10..1, tmdb_id 5991..6000) are the ones a real new arrival should displace.
        self.base = [_rec(i, 6001 - i) for i in range(1, 6001)]
        self.new_titles = [_rec(90000 + i, 999999 + i) for i in range(10)]
        patches = [
            mock.patch.object(pp, "CATALOGUE_TARGET", 6000),
            mock.patch.object(pp, "ingest_tmdb", lambda seen: list(self.new_titles)),
            mock.patch.object(pp, "ingest_tmdb_upcoming", lambda seen: []),
            mock.patch.object(pp, "ingest_tmdb_streaming", lambda seen: []),
            mock.patch.object(pp, "REVALIDATION_DAILY_BUDGET", 0),
            mock.patch.object(pp, "enrich_cinema_release", lambda m: m),
            mock.patch.object(pp, "TMDB_PACING", 0),
        ]
        for p in patches:
            p.start(); self.addCleanup(p.stop)

    def test_discovery_runs_and_the_cap_still_holds_at_6000(self):
        out = io.StringIO()
        with redirect_stdout(out):
            catalogue, _counts = pp.build_live_catalogue(self.today, self.base, {}, ondemand_ids=[])
        self.assertEqual(len(catalogue), 6000)

        ids = {m["tmdb_id"] for m in catalogue}
        for t in self.new_titles:
            self.assertIn(t["tmdb_id"], ids)

        # the 10 lowest-popularity incumbents (tmdb_id 5991..6000) were displaced.
        for displaced_id in range(5991, 6001):
            self.assertNotIn(displaced_id, ids)

        self.assertIn("discovered=10 new=10 dropped=10", out.getvalue())


if __name__ == "__main__":
    unittest.main()
