"""Unit tests for the digest renderer + phrasing (CAS-86 / spec 26771457 §6).

Run:  python -m unittest monitor.tests.test_emailer
"""
import io
import unittest
import urllib.error
from unittest import mock

from monitor import render_digest, moment_phrase, digest_subject
from monitor.emailer import USER_AGENT, send_via_resend
from monitor.matching import Hit
from monitor.transitions import Transition


def _hit(title, moment, cascade, services=None, price=None, prior_window=None,
         movie_id="1", cascade_id="c1"):
    t = Transition(movie_id=movie_id, title=title, moment=moment,
                   services=services or [], price=price, movie={})
    if prior_window is not None:
        t.prior_window = prior_window
    return Hit(user_id="user-A", cascade_id=cascade_id, cascade_name=cascade, transition=t)


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
            self.assertIn("Drama rentals", part)      # which Cascade caught it — named on the film itself
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
    """CAS-496: section headings were replaced by a per-film agent-name line (see AgentNamingTests)
    — these check what survives that change."""

    def setUp(self):
        self.hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night", prior_window="upcoming", movie_id="w"),
            _hit("The Long Walk", "past_opening_weekend", "Cinema date night", movie_id="tlw"),
            _hit("Sinners", "hits_stream", "Everyday favourites", services=["Netflix"],
                 prior_window="rental", movie_id="s"),
        ]

    def test_films_appear_in_hit_order(self):
        d = render_digest(self.hits, site_url="https://example.test/app/")
        for part in (d["html"], d["text"]):
            self.assertLess(part.index("Warfare"), part.index("The Long Walk"))
            self.assertLess(part.index("The Long Walk"), part.index("Sinners"))

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


class AgentNamingTests(unittest.TestCase):
    """CAS-496: each film names the agent(s) that caught it, on the film itself."""

    def test_one_agent_named_on_its_film(self):
        d = render_digest([_hit("Warfare", "hits_cinema", "Cinema date night")],
                           site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("Warfare", part)
            self.assertIn("Cinema date night", part)

    def test_two_agents_on_the_same_film_show_it_once_naming_both(self):
        hits = [
            _hit("Sinners", "hits_stream", "Everyday favourites", services=["Netflix"]),
            _hit("Sinners", "hits_stream", "Weekend picks", services=["Netflix"]),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Sinners"), 1)
            self.assertIn("Everyday favourites", part)
            self.assertIn("Weekend picks", part)

    def test_watch_it_hit_reads_your_picks(self):
        hit = _hit("Warfare", "hits_cinema", "Your picks", cascade_id=None)
        d = render_digest([hit], site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertIn("Your picks", part)

    def test_agent_and_watch_it_on_the_same_film_show_it_once_naming_both(self):
        hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night"),
            _hit("Warfare", "hits_cinema", "Your picks", cascade_id=None),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Warfare"), 1)
            self.assertIn("Cinema date night", part)
            self.assertIn("Your picks", part)

    def test_different_moments_for_the_same_film_stay_separate(self):
        # Two real, distinct events for the same film — never collapsed into one line.
        hits = [
            _hit("Warfare", "hits_cinema", "Cinema date night"),
            _hit("Warfare", "hits_stream", "Everyday favourites", services=["Netflix"]),
        ]
        d = render_digest(hits, site_url="https://x.test/")
        for part in (d["html"], d["text"]):
            self.assertEqual(part.count("Warfare"), 2)


class SendViaResendTests(unittest.TestCase):
    def test_request_carries_a_real_user_agent(self):
        resp = mock.MagicMock()
        resp.read.return_value = b'{"id": "abc"}'
        resp.__enter__.return_value = resp
        with mock.patch("urllib.request.urlopen", return_value=resp) as urlopen:
            send_via_resend("to@example.test", "Subj", "<p>hi</p>", "hi", api_key="k")
        req = urlopen.call_args[0][0]
        self.assertEqual(req.get_header("User-agent"), USER_AGENT)
        self.assertNotIn("python-urllib", req.get_header("User-agent").lower())

    def test_http_error_reports_status_content_type_body_and_from_no_key(self):
        err = urllib.error.HTTPError(
            url="https://api.resend.com/emails", code=403, msg="Forbidden",
            hdrs={"Content-Type": "text/html"}, fp=io.BytesIO(b"<html>blocked</html>"),
        )
        with mock.patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(RuntimeError) as ctx:
                send_via_resend("to@example.test", "Subj", "<p>hi</p>", "hi",
                                 api_key="super-secret-key", from_addr="Cascade <a@b.test>")
        message = str(ctx.exception)
        self.assertIn("403", message)
        self.assertIn("text/html", message)
        self.assertIn("blocked", message)
        self.assertIn("a@b.test", message)
        self.assertNotIn("super-secret-key", message)


if __name__ == "__main__":
    unittest.main()
