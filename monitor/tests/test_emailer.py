"""Unit tests for the digest renderer + phrasing (CAS-86 / spec 26771457 §6).

Run:  python -m unittest monitor.tests.test_emailer
"""
import unittest

from monitor import render_digest, moment_phrase, digest_subject
from monitor.matching import Hit
from monitor.transitions import Transition


def _hit(title, moment, cascade, services=None, price=None, prior_window=None):
    t = Transition(movie_id="1", title=title, moment=moment,
                   services=services or [], price=price, movie={})
    if prior_window is not None:
        t.prior_window = prior_window
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
            self.assertIn("Drama rentals", part)      # which Cascade caught it — now the section header
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


class SectioningTests(unittest.TestCase):
    def setUp(self):
        self.hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night", prior_window="upcoming"),
            _hit("The Long Walk", "past_opening_weekend", "Cinema date night"),
            _hit("Sinners", "hits_stream", "Everyday favourites", services=["Netflix"], prior_window="rental"),
        ]

    def test_sections_are_grouped_by_agent_alphabetically(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Cinema date night"), part.index("Everyday favourites"))

    def test_no_per_line_found_by_tag(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertNotIn("Found by your", part)

    def test_move_line_shown_when_prior_window_known(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Upcoming → In cinema", part)
            self.assertIn("Rent → Stream", part)

    def test_no_move_line_when_prior_window_unknown(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertIn("Past its opening weekend", part)
        # "The Long Walk" has no prior_window set — never invent a move for it.
        self.assertNotIn("→ Past", d["html"])

    def test_rendering_is_deterministic(self):
        d1 = render_digest(self.hits, site_url="https://example.test/app/")
        d2 = render_digest(self.hits, site_url="https://example.test/app/")
        self.assertEqual(d1, d2)


if __name__ == "__main__":
    unittest.main()
