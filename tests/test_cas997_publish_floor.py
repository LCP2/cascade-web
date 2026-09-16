"""CAS-997 — the publication floor (Defect 1) and the TMDB not-found drop (Defect 2).

Defect 1's engine-level boundary (isScoreable/scoreable_shim) is exercised in
tests/js/scoreable-shim.test.mjs — AC1 lives there, against the real shipped engine. This file
covers the pure-Python side: the floor plumbed through scoreable_ids (AC3 — the CAS-922 manifest's
own default-floor caller is unaffected), select_publishable's existing exemption applied to a
below-floor title (AC2), and drop_not_found_candidates (AC5).
"""
import datetime
import unittest
from unittest import mock

import poc_pipeline as pp


def _movie(tmdb_id, popularity=100, status=("included_streaming",), **fields):
    m = {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026", "popularity": popularity,
         "status": list(status), "offers": [], "cinema_date": "2026-01-01"}
    m.update(fields)
    return m


class ScoreableIdsFloorDefaultsToZero(unittest.TestCase):
    """AC3 — scoreable_ids's own default (no floor named) must behave exactly as it did before
    CAS-997, so the CAS-922 manifest's caller (which never names a floor) is unaffected."""

    def test_omitting_floor_is_the_same_as_floor_zero(self):
        below_60 = _movie(1, status=["included_streaming"], wm_user_rating=1)  # a real but low qScore
        self.assertEqual(pp.scoreable_ids([below_60]), pp.scoreable_ids([below_60], floor=0))


class SelectPublishableKeepsAHeldBelowFloorTitle(unittest.TestCase):
    """AC2 — a title the engine no longer counts scoreable (because it fell below the publish
    floor) but that a user holds state on must still publish, counted exempt. select_publishable
    itself doesn't know why a title left engine_scoreable_ids — this proves the floor's exclusion
    feeds that same existing exemption path, not a special case of its own."""

    def test_a_below_floor_held_title_is_kept_and_counted_exempt(self):
        candidates = {str(i): _movie(i, 100 - i) for i in range(1, 4)}
        # Title 2 was published yesterday; today the engine (post-floor) no longer counts it
        # scoreable — engine_scoreable_ids below stands in for that real scoreable_ids(floor=60)
        # answer, same as this ticket's Defect 1 wires it in apply_two_tier_publication.
        engine_scoreable_ids = {1, 3}
        previously_published_ids = {1, 2, 3}
        records, stats = pp.select_publishable(candidates, engine_scoreable_ids,
                                                previously_published_ids, held_ids={2},
                                                catalogue_target=10)
        self.assertEqual(stats["demoted"], 0)
        self.assertEqual(stats["exempt"], 1)
        self.assertIn(2, {m["tmdb_id"] for m in records})

    def test_the_same_below_floor_title_not_held_is_demoted(self):
        candidates = {str(i): _movie(i, 100 - i) for i in range(1, 4)}
        records, stats = pp.select_publishable(candidates, {1, 3}, {1, 2, 3}, held_ids=set(),
                                                catalogue_target=10)
        self.assertEqual(stats["demoted"], 1)
        self.assertNotIn(2, {m["tmdb_id"] for m in records})


class DropNotFoundCandidates(unittest.TestCase):
    """AC5 — a candidate not-found on TMDB_NOT_FOUND_DROP_STREAK consecutive nightly runs is
    dropped from candidates.json unless a user holds state on it."""

    def test_below_streak_is_kept(self):
        candidates = {"1": _movie(1, tmdb_not_found_streak=pp.TMDB_NOT_FOUND_DROP_STREAK - 1)}
        dropped = pp.drop_not_found_candidates(candidates, held_ids=set())
        self.assertEqual(dropped, 0)
        self.assertIn("1", candidates)

    def test_at_streak_is_dropped(self):
        candidates = {"1": _movie(1, tmdb_not_found_streak=pp.TMDB_NOT_FOUND_DROP_STREAK)}
        dropped = pp.drop_not_found_candidates(candidates, held_ids=set())
        self.assertEqual(dropped, 1)
        self.assertNotIn("1", candidates)

    def test_a_held_title_at_streak_is_never_dropped(self):
        candidates = {"1": _movie(1, tmdb_not_found_streak=pp.TMDB_NOT_FOUND_DROP_STREAK)}
        dropped = pp.drop_not_found_candidates(candidates, held_ids={1})
        self.assertEqual(dropped, 0)
        self.assertIn("1", candidates)

    def test_held_ids_none_drops_nothing_at_all(self):
        candidates = {"1": _movie(1, tmdb_not_found_streak=pp.TMDB_NOT_FOUND_DROP_STREAK + 5)}
        dropped = pp.drop_not_found_candidates(candidates, held_ids=None)
        self.assertEqual(dropped, 0)
        self.assertIn("1", candidates)


class ApplyTwoTierPublicationDropsNotFoundBeforePublishing(unittest.TestCase):
    """AC5 (integration) — a title dropped for its not-found streak never reaches the engine call
    or the published set, and the run reports how many were dropped."""

    def test_a_dropped_title_is_gone_from_candidates_and_never_published(self):
        candidates = {
            "1": _movie(1, 100),
            "2": _movie(2, 50, tmdb_not_found_streak=pp.TMDB_NOT_FOUND_DROP_STREAK),
        }
        with mock.patch.object(pp, "scoreable_ids", return_value={1, 2}), \
             mock.patch.object(pp, "run_scoreability_probe",
                               return_value={"ok": 0, "cached": 0, "no-id": 0, "skip": 0,
                                             "stop": 0, "probed": 0}), \
             mock.patch.object(pp, "load_user_held_ids", return_value=set()):
            published, report = pp.apply_two_tier_publication(
                candidates, datetime.date(2026, 9, 16), [], [], previously_published_ids=set())
        self.assertNotIn("2", candidates)
        self.assertEqual({m["tmdb_id"] for m in published}, {1})
        self.assertEqual(report["not_found_dropped"], 1)


if __name__ == "__main__":
    unittest.main()
