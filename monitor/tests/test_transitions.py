"""Unit tests for the monitoring diff (CAS-84 / spec 26771457 §5).

Run:  python -m unittest monitor.tests.test_transitions   (from the repo root)
"""
import datetime as _dt
import os
import unittest

from monitor import compute_transitions
from monitor.catalogue import load_catalogue_file

_HERE = os.path.dirname(os.path.abspath(__file__))
_FIX = os.path.join(os.path.dirname(_HERE), "fixtures")
RUN_DATE = _dt.date(2026, 7, 16)   # fixtures are authored around this date


def _load(name):
    return load_catalogue_file(os.path.join(_FIX, name))


class TransitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prev = _load("yesterday.json")
        cls.today = _load("today.json")

    def _run(self, n=4, date=RUN_DATE):
        return compute_transitions(self.prev, self.today, date, weekend_n=n)

    def _pairs(self, transitions):
        return {(t.movie_id, t.moment) for t in transitions}

    # ---- the four transition types are detected ----
    def test_all_four_moments_detected(self):
        pairs = self._pairs(self._run())
        self.assertEqual(pairs, {
            ("5001", "hits_rent"),              # pvod -> rental
            ("5002", "hits_stream"),            # gained included_streaming
            ("5003", "hits_cinema"),            # upcoming -> in_cinema
            ("5004", "past_opening_weekend"),   # today == opening (07-12) + 4
        })

    # ---- hits_pvod (CAS-103): the Purchase bell's moment ----
    # Built inline rather than in the shared fixtures so the expected-set test above keeps asserting
    # an exact set — a new fixture film would quietly widen it.
    def _pvod_case(self, offers):
        prev = [{"tmdb_id": 7001, "title": "Premium Riser", "status": ["in_cinema"]}]
        today = [{"tmdb_id": 7001, "title": "Premium Riser", "status": ["in_cinema", "pvod"],
                  "offers": offers}]
        return compute_transitions(prev, today, RUN_DATE)

    def test_pvod_arrival_fires(self):
        ts = self._pvod_case([{"type": "buy", "service": "Apple TV", "price": 24.99}])
        self.assertEqual(self._pairs(ts), {("7001", "hits_pvod")})

    def test_pvod_detail_has_services_and_cheapest_price(self):
        ts = self._pvod_case([
            {"type": "buy", "service": "Apple TV", "price": 24.99},
            {"type": "rent", "service": "Prime Video", "price": 19.99},   # > rental ceiling -> pvod
            {"type": "rent", "service": "Cheap Rents", "price": 4.99},    # standard rental, not pvod
        ])
        t = ts[0]
        self.assertEqual(t.moment, "hits_pvod")
        self.assertEqual(t.services, ["Apple TV", "Prime Video"])
        self.assertEqual(t.price, 19.99)          # cheapest PREMIUM offer, not the $4.99 rental

    def test_pvod_first_sighting_never_fires(self):
        today = [{"tmdb_id": 7002, "title": "Brand New", "status": ["pvod"], "offers": []}]
        self.assertEqual(compute_transitions([], today, RUN_DATE), [])

    # ---- honesty guardrails: no false positives ----
    def test_first_sighting_never_fires(self):
        # 5005 is brand-new today (rental) and absent yesterday -> not a transition.
        pairs = self._pairs(self._run())
        self.assertNotIn(("5005", "hits_rent"), pairs)
        self.assertFalse(any(mid == "5005" for mid, _ in pairs))

    def test_already_in_window_not_refired(self):
        # 5002 was already 'rental' yesterday -> only the NEW window (stream) fires, not rent.
        pairs = self._pairs(self._run())
        self.assertIn(("5002", "hits_stream"), pairs)
        self.assertNotIn(("5002", "hits_rent"), pairs)

    def test_unchanged_film_silent(self):
        pairs = self._pairs(self._run())
        self.assertFalse(any(mid == "5006" for mid, _ in pairs))  # included_streaming both days

    # ---- past_opening_weekend is real-date + N driven and tunable ----
    def test_past_opening_weekend_uses_real_date(self):
        pairs = self._pairs(self._run())
        # 5001's cinema_date is 2026-01-10 -> nowhere near today+/-N -> no weekend moment.
        self.assertNotIn(("5001", "past_opening_weekend"), pairs)

    def test_weekend_n_is_tunable(self):
        # With N=5, opening(07-12)+5 = 07-17 != run date -> 5004 no longer fires the weekend moment.
        pairs = self._pairs(self._run(n=5))
        self.assertNotIn(("5004", "past_opening_weekend"), pairs)
        # With N=4 it does (sanity re-assert).
        self.assertIn(("5004", "past_opening_weekend"), self._pairs(self._run(n=4)))

    def test_missing_opening_date_never_fires_weekend(self):
        prev = []
        today = [{"tmdb_id": 9, "title": "No Date", "status": ["in_cinema"], "cinema_date": None, "offers": []}]
        self.assertEqual(compute_transitions(prev, today, RUN_DATE), [])

    # ---- moment detail (for the email + streaming-service match downstream) ----
    def test_rent_detail_has_services_and_cheapest_price(self):
        t = next(t for t in self._run() if t.movie_id == "5001")
        self.assertEqual(t.moment, "hits_rent")
        self.assertEqual(t.price, 6.99)                       # cheapest of 6.99 / 7.99
        self.assertEqual(set(t.services), {"AppleTV", "GooglePlay"})

    def test_stream_detail_lists_service_no_price(self):
        t = next(t for t in self._run() if t.movie_id == "5002")
        self.assertEqual(t.services, ["Stan"])
        self.assertIsNone(t.price)

    def test_empty_yesterday_is_all_first_sightings(self):
        # First ever run (no 'yesterday'): nothing is a transition except date-computed weekend.
        transitions = compute_transitions([], self.today, RUN_DATE)
        pairs = self._pairs(transitions)
        self.assertEqual(pairs, {("5004", "past_opening_weekend")})


if __name__ == "__main__":
    unittest.main()
