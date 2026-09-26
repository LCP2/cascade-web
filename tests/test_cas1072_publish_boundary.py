"""CAS-1072 — a below-floor, non-held film stayed published after its cinema-buzz exemption
(CAS-289's estimate-window cap, poll_scheduler.CINEMA_ESTIMATE_CAP_DAYS / app_template.html's
twin CINEMA_ESTIMATE_RUN_DAYS) expired.

Investigation found no defect in select_publishable/isScoreable themselves — both correctly drop
such a title today, against real current data (verified by hand: `demoted` includes exactly the
titles this ticket names, none of them held). The three named films, and four more sharing the
same shape, stayed published only because the committed catalogue had gone stale: nothing had
re-run apply_two_tier_publication since the org's repo transfer broke the scheduler that dispatches
daily.yml (fixed by CAS-1071), so no run re-evaluated them after their estimate window lapsed.
movies.json was corrected directly (the seven no-longer-qualifying records removed) as this
ticket's Change item 4 authorises for committed data.

What was missing, and what this file adds: no existing test exercised the REAL engine
(scoreable_ids -> scripts/scoreable_shim.mjs -> isScoreable) against an ESTIMATED "in_cinema"
claim whose cinema_date has aged past the estimate window — the exact shape that produced the
real offenders. tests/test_cas997_publish_floor.py's select_publishable tests mock
engine_scoreable_ids directly, which proves select_publishable's OWN logic but not this
engine integration. This closes that gap so a regression in the re-derive branch (or in
CINEMA_ESTIMATE_RUN_DAYS itself) is caught here rather than only in production.

Run: python -m unittest tests.test_cas1072_publish_boundary
"""
import datetime
import unittest

import poc_pipeline as pp
from poll_scheduler import CINEMA_ESTIMATE_CAP_DAYS

TODAY = datetime.date.today()


def _aged_cinema_estimate(tmdb_id, days_since_cinema_date):
    """Shaped exactly like the real CAS-1072 offenders: an ESTIMATED availability claim of
    `in_cinema`, no offers, no Watchmode rating fields — nothing but an ageing opening date
    backs the claim."""
    cinema_date = (TODAY - datetime.timedelta(days=days_since_cinema_date)).isoformat()
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2026",
            "cinema_date": cinema_date, "genres": ["Documentary"], "release_dates": [],
            "status": ["in_cinema"], "offers": [], "availability_confidence": "estimated",
            # The real CAS-1072 offenders all carried a Watchmode popularity percentile (buzz's
            # own signal) with no critic/user rating behind it — that combination is what makes
            # the cinema-buzz exemption, not the floor, the thing that decides them either way.
            "wm_popularity_percentile": 70.0}


class AgedCinemaEstimateLosesItsFloorExemption(unittest.TestCase):
    """The real engine (not a mock) re-derives status from claimedStatus + cinema_date before
    deciding scoreability — see wm_scoreable_manifest.mjs's isScoreable. An ESTIMATED in_cinema
    claim is buzz-exempt from the floor while its window holds, and loses that exemption the
    moment CINEMA_ESTIMATE_RUN_DAYS/CINEMA_ESTIMATE_CAP_DAYS elapses, per CAS-289/CAS-1040."""

    def test_within_the_estimate_window_the_buzz_exemption_still_applies(self):
        fresh = _aged_cinema_estimate(1, CINEMA_ESTIMATE_CAP_DAYS - 5)
        self.assertIn(1, pp.scoreable_ids([fresh], floor=pp.WM_PUBLISH_FLOOR))

    def test_past_the_estimate_window_a_below_floor_claim_is_not_scoreable(self):
        aged = _aged_cinema_estimate(2, CINEMA_ESTIMATE_CAP_DAYS + 2)
        self.assertNotIn(2, pp.scoreable_ids([aged], floor=pp.WM_PUBLISH_FLOOR))


class SelectPublishableDropsAnAgedEstimateThatIsNotHeld(unittest.TestCase):
    """Integration: the same aged, below-floor, non-held title, already in yesterday's published
    set, must not survive select_publishable today — the exact CAS-1072 scenario. A held twin
    stays published (CAS-1067's existing exemption, unaffected)."""

    def test_a_non_held_aged_estimate_is_demoted(self):
        aged = _aged_cinema_estimate(3, CINEMA_ESTIMATE_CAP_DAYS + 10)
        candidates = {"3": aged}
        engine_ids = pp.scoreable_ids([aged], floor=pp.WM_PUBLISH_FLOOR)
        published, stats = pp.select_publishable(
            candidates, engine_ids, previously_published_ids={3}, held_ids=set(),
            catalogue_target=10)
        self.assertEqual(stats["demoted"], 1)
        self.assertNotIn(3, {m["tmdb_id"] for m in published})

    def test_the_same_aged_estimate_held_stays_published(self):
        aged = _aged_cinema_estimate(4, CINEMA_ESTIMATE_CAP_DAYS + 10)
        candidates = {"4": aged}
        engine_ids = pp.scoreable_ids([aged], floor=pp.WM_PUBLISH_FLOOR)
        published, stats = pp.select_publishable(
            candidates, engine_ids, previously_published_ids={4}, held_ids={"4"},
            catalogue_target=10)
        self.assertEqual(stats["exempt"], 1)
        self.assertIn(4, {m["tmdb_id"] for m in published})


if __name__ == "__main__":
    unittest.main()
