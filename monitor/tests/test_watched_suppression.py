"""CAS-788: marking a film Watched or "not for me" must stop its alerts, both the agent bell
(match()) and the per-film Watch-it tick (match_film_watches()) — via the existing `film_picks`
personal-override channel (`suppressed_pairs`), now wired into `monitor.__main__.main` for the
first time. Exercised end to end (--picks through the real CLI), not just at the match() unit
level, since the bug was the wiring, not the suppression logic itself.

monitor/fixtures/cas788_*.json: u788-A's Drama-rentals agent matches both 7001 (Watched Riser)
and 7003 (Clean Riser) crossing pvod -> rental; u788-B's Weekend-thrillers agent matches 7002
(Blocked Weekend); a lone film_watch tick (no agent covers it) sits on 7004 (Quiet Stream, a
Comedy neither agent asks about) crossing into streaming. cas788_picks.json marks 7001 (watched),
7002 (blocked) and 7004 (watched) all "off".
"""
import io
import unittest
from contextlib import redirect_stdout

from monitor.__main__ import main

FIXTURES = "monitor/fixtures"


def _run(picks=True):
    argv = [
        "--today", f"{FIXTURES}/cas788_today.json",
        "--yesterday", f"{FIXTURES}/cas788_yesterday.json",
        "--date", "2026-07-16", "--dry-run",
        "--cascades", f"{FIXTURES}/cas788_cascades.json",
        "--watches", f"{FIXTURES}/cas788_watches.json",
    ]
    if picks:
        argv += ["--picks", f"{FIXTURES}/cas788_picks.json"]
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = main(argv)
    return rc, buf.getvalue()


class WatchedAndBlockedSuppressAlerts(unittest.TestCase):
    """The raw transitions catalogue-diff always lists every title it saw (that's printed before
    matching runs at all, see monitor/__main__.py's `for t in transitions: print(...)`), so a
    suppressed film's name still appears there — these assertions target the delivered-hit lines
    (`[cascade name] Title`) that only print for what actually matched, printed right after the
    "N new alert(s)" summary."""

    def test_a_watched_film_crossing_a_window_produces_no_hit(self):
        rc, out = _run()
        self.assertEqual(rc, 0)
        self.assertNotIn("[Drama rentals] Watched Riser", out)

    def test_a_blocked_film_likewise_produces_no_hit(self):
        rc, out = _run()
        self.assertEqual(rc, 0)
        self.assertNotIn("[Weekend thrillers] Blocked Weekend", out)

    def test_an_unwatched_film_in_the_same_fixture_still_fires(self):
        rc, out = _run()
        self.assertEqual(rc, 0)
        self.assertIn("[Drama rentals] Clean Riser", out)

    def test_a_film_watch_row_for_a_watched_film_produces_no_hit(self):
        rc, out = _run()
        self.assertEqual(rc, 0)
        self.assertNotIn("[Your picks] Quiet Stream", out)

    def test_exactly_one_alert_survives_the_three_suppressions(self):
        rc, out = _run()
        self.assertEqual(rc, 0)
        self.assertIn("1 new alert(s)", out)

    def test_without_the_picks_override_all_four_would_have_fired(self):
        # Control: proves the fixtures themselves produce all four hits absent CAS-788's fix, so
        # the assertions above are really about suppression and not a fixture that never matched.
        rc, out = _run(picks=False)
        self.assertEqual(rc, 0)
        self.assertIn("4 new alert(s)", out)
        for line in ("[Drama rentals] Watched Riser", "[Weekend thrillers] Blocked Weekend",
                    "[Drama rentals] Clean Riser", "[Your picks] Quiet Stream"):
            self.assertIn(line, out)


if __name__ == "__main__":
    unittest.main()
