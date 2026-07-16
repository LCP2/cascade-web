"""Unit tests for the digest renderer + phrasing (CAS-86 / spec 26771457 §6).

Run:  python -m unittest monitor.tests.test_emailer
"""
import unittest

from monitor import render_digest, moment_phrase, digest_subject
from monitor.matching import Hit
from monitor.transitions import Transition


def _hit(title, moment, cascade, services=None, price=None):
    t = Transition(movie_id="1", title=title, moment=moment,
                   services=services or [], price=price, movie={})
    return Hit(user_id="user-A", cascade_id="c1", cascade_name=cascade, transition=t)


class PhraseTests(unittest.TestCase):
    def test_stream_names_service(self):
        t = _hit("A", "hits_stream", "x", services=["Netflix"]).transition
        self.assertEqual(moment_phrase(t), "Now on Netflix")

    def test_stream_without_service_is_generic(self):
        t = _hit("A", "hits_stream", "x").transition
        self.assertIn("streaming", moment_phrase(t).lower())

    def test_rent_shows_real_price(self):
        t = _hit("A", "hits_rent", "x", price=4.99).transition
        self.assertEqual(moment_phrase(t), "Dropped to rent — $4.99")

    def test_rent_without_price_is_honest(self):
        t = _hit("A", "hits_rent", "x").transition
        self.assertEqual(moment_phrase(t), "Now available to rent")

    def test_cinema_and_weekend(self):
        self.assertEqual(moment_phrase(_hit("A", "hits_cinema", "x").transition), "In cinemas now")
        self.assertEqual(moment_phrase(_hit("A", "past_opening_weekend", "x").transition),
                         "Past its opening weekend")

    def test_no_fabricated_urgency(self):
        # Honesty guardrail: the weekend line must not invent a "leaving"/countdown claim.
        line = moment_phrase(_hit("A", "past_opening_weekend", "x").transition).lower()
        for banned in ("leaving", "last chance", "hurry", "expires", "gone in"):
            self.assertNotIn(banned, line)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.hits = [
            _hit("Rent Riser", "hits_rent", "Drama rentals", price=6.99),
            _hit("Stream Arrival", "hits_stream", "Comedy on Stan", services=["Stan"]),
        ]

    def test_subject_counts_updates(self):
        self.assertEqual(digest_subject(self.hits), "Cascade found 2 updates for you")
        self.assertEqual(digest_subject(self.hits[:1]), "Cascade found 1 update for you")

    def test_one_consolidated_digest_lists_every_item(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Rent Riser", part)
            self.assertIn("Stream Arrival", part)
            self.assertIn("Drama rentals", part)      # which Cascade caught it
            self.assertIn("Comedy on Stan", part)
        self.assertIn("$6.99", d["html"])             # real price, real service
        self.assertIn("Now on Stan", d["html"])
        self.assertIn("https://example.test/app/", d["html"])   # link back to the site

    def test_html_escapes_user_content(self):
        hit = _hit("Bad <script>", "hits_cinema", "My \"quoted\" & <b>Cascade</b>")
        d = render_digest([hit], site_url="https://x.test/")
        self.assertNotIn("<script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])

    def test_site_url_default_is_the_live_site(self):
        d = render_digest(self.hits)
        self.assertIn("lcp2.github.io/cascade-web", d["html"])


if __name__ == "__main__":
    unittest.main()
