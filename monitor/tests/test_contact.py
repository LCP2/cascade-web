"""Unit tests for the Contact-us digest (CAS-836).

Run:  python -m unittest monitor.tests.test_contact
"""
import unittest
from unittest import mock

from monitor.contact import digest_subject, main, render_digest
from monitor.store import InMemoryStore


def _row(id=1, user_id=None, category="bug", email="guest@example.test",
         message="It broke.", diagnostics=None, build="1.0.0",
         created_at="2026-07-16T09:00:00+00:00", sent_at=None, attachment_path=None):
    return {"id": id, "user_id": user_id, "client_key": f"device-{id}", "category": category,
            "email": email, "message": message, "diagnostics": diagnostics, "build": build,
            "created_at": created_at, "sent_at": sent_at, "attachment_path": attachment_path}


class RenderTests(unittest.TestCase):
    def test_subject_counts_messages(self):
        self.assertEqual(digest_subject([_row()]), "Cascade contact — 1 message")
        self.assertEqual(digest_subject([_row(1), _row(2)]), "Cascade contact — 2 messages")

    def test_digest_lists_every_message(self):
        store = InMemoryStore()
        rows = [_row(1, category="bug", message="Bug body"),
                _row(2, category="suggestion", message="Suggestion body"),
                _row(3, category="account", message="Account body")]
        d = render_digest(rows, store)
        for part in (d["html"], d["text"]):
            self.assertIn("Bug body", part)
            self.assertIn("Suggestion body", part)
            self.assertIn("Account body", part)

    def test_who_prefers_account_email_over_supplied_email(self):
        store = InMemoryStore(emails={"u1": "account@example.test"})
        row = _row(user_id="u1", email="supplied@example.test")
        d = render_digest([row], store)
        self.assertIn("account@example.test", d["text"])
        self.assertNotIn("supplied@example.test", d["text"])

    def test_who_falls_back_to_supplied_email(self):
        store = InMemoryStore()
        row = _row(user_id=None, email="supplied@example.test")
        d = render_digest([row], store)
        self.assertIn("supplied@example.test", d["text"])

    def test_who_never_guesses(self):
        store = InMemoryStore()
        row = _row(user_id=None, email=None)
        d = render_digest([row], store)
        self.assertIn("not given", d["text"])

    def test_diagnostics_rendered_verbatim_in_a_pre_block(self):
        store = InMemoryStore()
        row = _row(diagnostics="stack trace line 1\nstack trace line 2")
        d = render_digest([row], store)
        self.assertIn("<pre", d["html"])
        self.assertIn("stack trace line 1", d["html"])
        self.assertIn("stack trace line 2", d["html"])

    def test_no_diagnostics_no_pre_block(self):
        store = InMemoryStore()
        row = _row(diagnostics=None)
        d = render_digest([row], store)
        self.assertNotIn("<pre", d["html"])

    def test_html_escapes_message_content(self):
        store = InMemoryStore()
        row = _row(message="<script>alert(1)</script>")
        d = render_digest([row], store)
        self.assertNotIn("<script>alert(1)</script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])

    def test_attachment_path_produces_a_signed_link_in_the_digest(self):
        store = InMemoryStore()
        row = _row(attachment_path="device-1/123-shot.png")
        d = render_digest([row], store)
        url = store.sign_attachment_url(row["attachment_path"])
        self.assertIn(url, d["html"])
        self.assertIn(url, d["text"])

    def test_no_attachment_path_no_link(self):
        store = InMemoryStore()
        row = _row(attachment_path=None)
        d = render_digest([row], store)
        self.assertNotIn("Attachment", d["text"])
        self.assertNotIn("View attachment", d["html"])


class MainDryRunTests(unittest.TestCase):
    def test_dry_run_prints_digest_and_sends_nothing(self):
        store = InMemoryStore(contact_messages=[_row(1)])
        with mock.patch("monitor.contact.store_from_env", return_value=store), \
             mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertEqual(len(store.fetch_unsent_contact_messages()), 1)

    def test_empty_fixture_prints_no_digest_and_exits_zero(self):
        store = InMemoryStore(contact_messages=[])
        with mock.patch("monitor.contact.store_from_env", return_value=store), \
             mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main(["--dry-run"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_no_store_and_no_messages_flag_exits_zero(self):
        with mock.patch("monitor.contact.store_from_env", return_value=None):
            self.assertEqual(main([]), 0)


class MainLiveSendTests(unittest.TestCase):
    def test_no_contact_to_logs_and_sends_nothing(self):
        store = InMemoryStore(contact_messages=[_row(1)])
        with mock.patch("monitor.contact.store_from_env", return_value=store), \
             mock.patch.dict("os.environ", {}, clear=True), \
             mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()
        self.assertIsNone(store.fetch_unsent_contact_messages()[0]["sent_at"])

    def test_successful_send_stamps_sent_at_on_every_row(self):
        store = InMemoryStore(contact_messages=[_row(1), _row(2)])
        with mock.patch("monitor.contact.store_from_env", return_value=store), \
             mock.patch.dict("os.environ", {"CASCADE_CONTACT_TO": "lee@example.test"}, clear=True), \
             mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main([])
        self.assertEqual(exit_code, 0)
        send.assert_called_once()
        self.assertEqual(send.call_args[0][0], "lee@example.test")
        self.assertEqual(store.fetch_unsent_contact_messages(), [])

    def test_send_failure_leaves_sent_at_unstamped(self):
        store = InMemoryStore(contact_messages=[_row(1), _row(2)])
        with mock.patch("monitor.contact.store_from_env", return_value=store), \
             mock.patch.dict("os.environ", {"CASCADE_CONTACT_TO": "lee@example.test"}, clear=True), \
             mock.patch("monitor.contact.send_via_resend", side_effect=RuntimeError("resend down")):
            exit_code = main([])
        self.assertEqual(exit_code, 1)
        unsent = store.fetch_unsent_contact_messages()
        self.assertEqual(len(unsent), 2)
        self.assertTrue(all(r["sent_at"] is None for r in unsent))


class MessagesFixtureFlagTests(unittest.TestCase):
    def test_messages_flag_loads_from_file(self):
        with mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main(["--dry-run", "--messages", "monitor/fixtures/contact_messages.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()

    def test_messages_flag_empty_fixture_exits_zero(self):
        with mock.patch("monitor.contact.send_via_resend") as send:
            exit_code = main(["--dry-run", "--messages",
                               "monitor/fixtures/contact_messages_empty.json"])
        self.assertEqual(exit_code, 0)
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
