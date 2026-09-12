"""Unit tests for the reply-arrived email (CAS-967).

Run:  python -m unittest monitor.tests.test_invitereply
"""
import unittest
from unittest import mock

from monitor.invitereply import email_subject, main, render_email
from monitor.store import InMemoryStore


def _row(id=1, sender_id="user-A", to_name="Sam", film_title="Test Film", tmdb_id=12345,
         answer="yes", created_at="2026-09-12T09:00:00+00:00", notified_at=None,
         token="abc1234567"):
    return {"id": id, "token": token, "sender_id": sender_id, "to_name": to_name,
            "film_title": film_title, "tmdb_id": tmdb_id, "answer": answer,
            "created_at": created_at, "notified_at": notified_at}


class RenderTests(unittest.TestCase):
    def test_subject_names_the_outcome_for_a_single_reply(self):
        self.assertEqual(
            email_subject([_row(to_name="Sam", answer="yes", film_title="Practical Magic 2")]),
            "Sam said yes to Practical Magic 2")

    def test_subject_is_a_count_for_several_replies(self):
        self.assertEqual(email_subject([_row(1), _row(2), _row(3)]), "3 replies to your invites")

    def test_a_no_reply_is_described_as_no(self):
        email = render_email([_row(answer="no", to_name="Sam", film_title="Test Film")])
        self.assertIn("Sam said no to Test Film", email["subject"])
        self.assertIn("no", email["text"])

    def test_email_contains_every_reply_in_the_group(self):
        email = render_email([_row(1, to_name="Sam", film_title="Film One"),
                               _row(2, to_name="Priya", film_title="Film Two")])
        self.assertIn("Sam", email["html"])
        self.assertIn("Film One", email["html"])
        self.assertIn("Priya", email["html"])
        self.assertIn("Film Two", email["html"])

    def test_html_escapes_names_and_film_title(self):
        email = render_email([_row(to_name="<script>alert(1)</script>", film_title="Test Film")])
        self.assertNotIn("<script>alert(1)</script>", email["html"])
        self.assertIn("&lt;script&gt;", email["html"])


class MainDryRunTests(unittest.TestCase):
    def test_dry_run_sends_nothing_and_stamps_nothing(self):
        store = InMemoryStore(invite_replies=[_row(1), _row(2, sender_id="user-B")])
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(len(store.fetch_unnotified_invite_replies()), 2)

    def test_empty_fixture_renders_nothing_and_exits_zero(self):
        store = InMemoryStore(invite_replies=[])
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_no_store_and_no_fixture_flag_exits_zero(self):
        with mock.patch("monitor.invitereply.store_from_env", return_value=None):
            self.assertEqual(main([]), 0)


class GroupingTests(unittest.TestCase):
    """AC3a/AC3b: one email per sender per run, covering however many replies that sender has."""

    def test_two_replies_same_sender_produce_one_email_naming_both(self):
        rows = [_row(1, sender_id="user-A", to_name="Sam", film_title="Film One"),
                _row(2, sender_id="user-A", to_name="Priya", film_title="Film Two")]
        store = InMemoryStore(invite_replies=rows, emails={"user-A": "a@example.test"})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_called_once()
        to_addr, _subject, html, _text = send.call_args[0]
        self.assertEqual(to_addr, "a@example.test")
        self.assertIn("Sam", html)
        self.assertIn("Priya", html)

    def test_two_senders_produce_two_emails_with_no_cross_contamination(self):
        rows = [_row(1, sender_id="user-A", to_name="Sam", film_title="Film One"),
                _row(2, sender_id="user-B", to_name="Priya", film_title="Film Two")]
        store = InMemoryStore(invite_replies=rows,
                               emails={"user-A": "a@example.test", "user-B": "b@example.test"})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        self.assertEqual(send.call_count, 2)
        by_addr = {c.args[0]: c.args[2] for c in send.call_args_list}
        self.assertIn("Sam", by_addr["a@example.test"])
        self.assertNotIn("Priya", by_addr["a@example.test"])
        self.assertIn("Priya", by_addr["b@example.test"])
        self.assertNotIn("Sam", by_addr["b@example.test"])


class NotifiedAtLedgerTests(unittest.TestCase):
    def test_notified_at_not_stamped_when_send_raises(self):
        store = InMemoryStore(invite_replies=[_row(1, sender_id="user-A")],
                               emails={"user-A": "a@example.test"})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend",
                         side_effect=RuntimeError("resend down")):
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        unnotified = store.fetch_unnotified_invite_replies()
        self.assertEqual(len(unnotified), 1)
        self.assertIsNone(unnotified[0]["notified_at"])

    def test_a_reply_with_no_resolvable_sender_is_skipped_not_crashed(self):
        orphan = _row(1, sender_id=None, to_name=None, film_title=None)
        store = InMemoryStore(invite_replies=[orphan, _row(2, sender_id="user-A")],
                               emails={"user-A": "a@example.test"})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_called_once()

    def test_running_twice_over_the_same_data_notifies_once(self):
        store = InMemoryStore(invite_replies=[_row(1, sender_id="user-A")],
                               emails={"user-A": "a@example.test"})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code_1 = main([])
            exit_code_2 = main([])
        self.assertEqual(exit_code_1, 0)
        self.assertEqual(exit_code_2, 0)
        self.assertEqual(send.call_count, 1)

    def test_a_sender_with_no_resolvable_email_is_skipped_not_crashed(self):
        store = InMemoryStore(invite_replies=[_row(1, sender_id="user-A")], emails={})
        with mock.patch("monitor.invitereply.store_from_env", return_value=store), \
             mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(len(store.fetch_unnotified_invite_replies()), 1)


class RepliesFixtureFlagTests(unittest.TestCase):
    def test_replies_flag_loads_from_file(self):
        with mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main(["--dry-run", "--replies",
                               "monitor/fixtures/invite_replies_unnotified.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_replies_flag_empty_fixture_exits_zero(self):
        with mock.patch("monitor.invitereply.send_via_resend") as send:
            exit_code = main(["--dry-run", "--replies",
                               "monitor/fixtures/invite_replies_unnotified_empty.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
