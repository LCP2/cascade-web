"""CAS-887: pipeline-level behaviour for invite replies leading the daily digest.

Unit-level rendering (the block itself, its ordering inside one digest, subject wording) is
covered directly against render_digest/format_invite_reply in monitor/tests/test_emailer.py; this
file is about monitor.__main__.main()'s own wiring — which USERS get an email at all, and that a
digest run never writes invite_replies.seen_at (item 5 of the ticket).

Run:  python -m unittest monitor.tests.test_invite_replies
"""
import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from monitor.__main__ import main
from monitor.store import InMemoryStore

FIXTURES = "monitor/fixtures"


def _run(argv, invite_replies_override=None):
    """Runs main(), optionally forcing the InMemoryStore it builds internally to hold a specific
    invite_replies list (main() owns construction, so a recording/overriding constructor is the
    only way to get at — or seed — that instance from outside). Returns (rc, stdout, store)."""
    created = {}
    real_cls = InMemoryStore

    def _make(*a, **kw):
        if invite_replies_override is not None:
            kw["invite_replies"] = invite_replies_override
        inst = real_cls(*a, **kw)
        created["store"] = inst
        return inst

    buf = io.StringIO()
    with mock.patch("monitor.__main__.InMemoryStore", side_effect=_make):
        with redirect_stdout(buf):
            rc = main(argv)
    return rc, buf.getvalue(), created["store"]


class RepliesOnlyStillSends(unittest.TestCase):
    """AC1b/AC2: a user with replies but no film transitions still gets a digest email — user-C
    in the fixtures has no cascades at all and exactly one undigested reply (invite_replies.json)."""

    def test_replies_only_user_gets_an_email(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--replies", f"{FIXTURES}/invite_replies.json",
            "--target-user", "user-C",
        ]
        with mock.patch("monitor.__main__.send_via_resend", return_value={"id": "test"}) as sent:
            rc, out, _ = _run(argv)
        self.assertEqual(rc, 0)
        self.assertIn("user user-C", out)
        self.assertIn("0 alert(s), 1 invite reply(s)", out)
        self.assertIn("email channel — sent", out)
        sent.assert_called_once()
        subject = sent.call_args[0][1]
        self.assertIn("reply to your invites", subject)


class NeitherGetsNothing(unittest.TestCase):
    """AC1c: a user with no hits AND no replies gets nothing — even while OTHER users' replies
    (invite_replies.json) exist in the same run."""

    def test_a_user_with_no_hits_and_no_replies_gets_nothing(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--replies", f"{FIXTURES}/invite_replies.json",
            "--target-user", "some-user-not-in-fixtures",
        ]
        rc, out, _ = _run(argv)
        self.assertEqual(rc, 0)
        self.assertIn("no new alerts for anyone", out)


class TwoRepliesTwoTransitionsOrdering(unittest.TestCase):
    """AC1a, exercised through the CLI: user-A has two real hits (Drama rentals/Cinema action) and
    two undigested replies (invite_replies.json) on 2026-07-16 — the replies must still lead."""

    def test_replies_lead_the_rendered_digest(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run", "--print-html",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--replies", f"{FIXTURES}/invite_replies.json",
            "--target-user", "user-A",
        ]
        rc, out, _ = _run(argv)
        self.assertEqual(rc, 0)
        self.assertIn("2 alert(s), 2 invite reply(s)", out)
        self.assertIn("Replies to your invites", out)
        self.assertLess(out.index("Replies to your invites"), out.index("Rent Riser"))


class NeverWritesSeenAt(unittest.TestCase):
    """AC1e: running the digest must never write invite_replies.seen_at — that stays the app's,
    stamped only when the sender actually opens the Invites screen."""

    def test_running_the_digest_leaves_seen_at_untouched(self):
        replies = [{
            "id": 501, "sender_id": "user-A", "to_name": "Sam", "film_title": "Rent Riser",
            "tmdb_id": 5001, "answer": "yes", "created_at": "2026-07-15T10:00:00Z",
            "seen_at": "2026-01-01T00:00:00Z",
        }]
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
            "--watches", f"{FIXTURES}/watches.json",
            "--target-user", "user-A",
        ]
        with mock.patch("monitor.__main__.send_via_resend", return_value={"id": "test"}):
            rc, out, store = _run(argv, invite_replies_override=replies)
        self.assertEqual(rc, 0)
        row = store._invite_replies[0]
        self.assertEqual(row["seen_at"], "2026-01-01T00:00:00Z")
        self.assertIsNotNone(row.get("digested_at"))


if __name__ == "__main__":
    unittest.main()
