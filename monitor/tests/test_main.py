"""CAS-416: a ledger-write failure must warn, not crash the run.

The daily job's most damaging failure mode isn't a bad send — it's `insert_notifications`
throwing on a schema mismatch and taking the whole run down with it, so every user after the
one that tripped it gets nothing. This exercises the CLI end-to-end against the fixtures with
a store that fails the ledger write, the same way a live 400 does.
"""
import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from monitor.__main__ import main
from monitor.store import InMemoryStore

FIXTURES = "monitor/fixtures"


class TargetUserSafetyValve(unittest.TestCase):
    """CAS-486: --target-user must scope a run to exactly one user, so the notify-test harness can
    never spray real users. monitor/fixtures has two: user-A (Drama rentals fires on tmdb_id 5001,
    pvod->rental) and user-B (unrelated cascades)."""

    def test_only_the_target_user_is_matched(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--target-user", "user-A",
        ]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(argv)
        self.assertEqual(rc, 0)
        out = buf.getvalue()
        self.assertIn("user user-A", out)
        self.assertNotIn("user user-B", out)

    def test_an_unmatched_target_user_delivers_to_no_one(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16", "--dry-run",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--target-user", "some-user-not-in-fixtures",
        ]
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = main(argv)
        self.assertEqual(rc, 0)
        self.assertIn("no new alerts for anyone", buf.getvalue())


class LedgerWriteResilience(unittest.TestCase):
    def test_a_ledger_write_failure_is_a_warning_not_a_crash(self):
        argv = [
            "--today", f"{FIXTURES}/today.json", "--yesterday", f"{FIXTURES}/yesterday.json",
            "--date", "2026-07-16",
            "--cascades", f"{FIXTURES}/cascades.json",
            "--notifications", f"{FIXTURES}/notifications.json",
            "--emails", f"{FIXTURES}/emails.json",
            "--prefs", f"{FIXTURES}/prefs.json",
        ]
        buf = io.StringIO()
        with mock.patch.object(InMemoryStore, "insert_notifications",
                                side_effect=RuntimeError("HTTP Error 400: Bad Request")):
            with redirect_stdout(buf):
                rc = main(argv)
        self.assertEqual(rc, 0)
        self.assertIn("could not write ledger", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
