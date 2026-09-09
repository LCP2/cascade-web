"""Unit tests for the Contact-us digest (CAS-836, redesigned CAS-892).

Run:  python -m unittest monitor.tests.test_contact
"""
import unittest
from unittest import mock

from monitor.contact import digest_subject, main, render_digest
from monitor.store import InMemoryStore

# A realistic diagReportText() block (app_template.html), including two rows the panel's
# recognised fields don't cover (Built at / Protocol / offsetTop / clientHeight), a sync line
# with no colon at all, and created_at-style microsecond precision nowhere but the row itself.
DIAG_BLOCK = """=== Cascade diagnostics ===

-- Identity --
Version: v1.0.0
Build: 1025
Commit: 9c75c67
Built at: 2026-07-15T04:00:00.000Z
Protocol: https:
Origin: https://cascademovies.com
Capacitor bridge: yes (web)
User agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36

-- Geometry --
innerWidth × innerHeight: 1830 × 896
visualViewport w × h: 1829.5 × 896.2
visualViewport offsetTop: 0
documentElement clientHeight: 896
safe-area-inset T/R/B/L: 0 / 0 / 0 / 0
devicePixelRatio: 1.05
orientation: landscape-primary

-- Account sync --
cascades: OK (2026-07-16T09:00:00.000Z)
user_films: not yet attempted
notify_prefs: FAILED (2026-07-16T09:05:00.000Z) — Could not find the 'excluded_moments' column of 'notify_prefs' in the schema cache
weird sync line with no colon at all

-- Log tail (2) --
[2026-07-16T09:06:00.000Z] warn: retry scheduled for notify_prefs
[2026-07-16T09:06:05.000Z] info: sync queue drained
"""


def _row(id=1, user_id=None, category="bug", email="guest@example.test",
         message="It broke.", diagnostics=None, build="v1.0.0 · build 1025 · 9c75c67",
         created_at="2026-07-16T09:12:00.123456+00:00", sent_at=None, attachment_path=None):
    return {"id": id, "user_id": user_id, "client_key": f"device-{id}", "category": category,
            "email": email, "message": message, "diagnostics": diagnostics, "build": build,
            "created_at": created_at, "sent_at": sent_at, "attachment_path": attachment_path}


class SubjectTests(unittest.TestCase):
    def test_single_bug_report(self):
        self.assertEqual(digest_subject([_row(category="bug")]), "Cascade contact — 1 bug report")

    def test_single_suggestion(self):
        self.assertEqual(digest_subject([_row(category="suggestion")]), "Cascade contact — 1 suggestion")

    def test_single_account_question(self):
        self.assertEqual(digest_subject([_row(category="account")]), "Cascade contact — 1 account question")

    def test_single_other_is_a_message(self):
        self.assertEqual(digest_subject([_row(category="other")]), "Cascade contact — 1 message")

    def test_multiple_messages_keeps_count_form(self):
        self.assertEqual(digest_subject([_row(1), _row(2)]), "Cascade contact — 2 messages")


class RenderTests(unittest.TestCase):
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

    def test_two_message_fixture_gets_two_cards_and_count_subject(self):
        store = InMemoryStore()
        rows = [_row(1, message="First message"), _row(2, message="Second message")]
        d = render_digest(rows, store)
        self.assertEqual(d["subject"], "Cascade contact — 2 messages")
        self.assertEqual(d["html"].count("First message") + d["html"].count("Second message"), 2)

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
        self.assertIn("no address given", d["text"])

    def test_html_escapes_message_content(self):
        store = InMemoryStore()
        row = _row(message="<script>alert(1)</script>")
        d = render_digest([row], store)
        self.assertNotIn("<script>alert(1)</script>", d["html"])
        self.assertIn("&lt;script&gt;", d["html"])

    def test_attachment_path_produces_a_named_signed_link(self):
        store = InMemoryStore()
        row = _row(attachment_path="device-1/1725900000-shot.png")
        d = render_digest([row], store)
        url = store.sign_attachment_url(row["attachment_path"])
        self.assertIn(url, d["html"])
        self.assertIn(url, d["text"])
        # The link text is the filename, with the upload's timestamp prefix stripped — not the
        # words "View attachment".
        self.assertIn(">shot.png<", d["html"])
        self.assertNotIn("View attachment", d["html"])

    def test_no_attachment_path_no_panel(self):
        store = InMemoryStore()
        row = _row(attachment_path=None)
        d = render_digest([row], store)
        self.assertNotIn("Attached", d["html"])
        self.assertNotIn("Attachment", d["text"])

    # ---- AC2 (a): Sydney time, never the raw microsecond ISO timestamp ----
    def test_created_at_renders_in_sydney_time_not_raw_iso(self):
        store = InMemoryStore()
        row = _row(created_at="2026-07-16T09:12:00.123456+00:00")
        d = render_digest([row], store)
        self.assertNotIn("2026-07-16T09:12:00.123456+00:00", d["html"])
        self.assertNotIn("T09:12:00.123456", d["html"])
        # UTC 2026-07-16T09:12 -> Sydney (AEST, +10) 2026-07-16 7:12pm.
        self.assertIn("Thu 16 Jul, 7:12pm", d["html"])

    def test_unparseable_created_at_prints_verbatim(self):
        store = InMemoryStore()
        row = _row(created_at="not-a-real-timestamp")
        d = render_digest([row], store)
        self.assertIn("not-a-real-timestamp", d["html"])

    # ---- AC2 (c)/(d): reply mailto ----
    def test_reply_button_links_to_the_row_address(self):
        store = InMemoryStore()
        row = _row(email="guest@example.test")
        d = render_digest([row], store)
        self.assertIn("mailto:guest@example.test", d["html"])

    def test_no_address_no_mailto_at_all(self):
        store = InMemoryStore()
        row = _row(user_id=None, email=None)
        d = render_digest([row], store)
        self.assertNotIn("mailto:", d["html"])
        self.assertIn("no address given", d["html"])

    # ---- AC2 (e)/(f): diagnostics — nothing silently dropped, raw text kept verbatim ----
    def test_diagnostics_every_value_represented_in_html(self):
        store = InMemoryStore()
        row = _row(diagnostics=DIAG_BLOCK)
        d = render_digest([row], store)
        html = d["html"]
        for token in (
            "https://cascademovies.com",           # Origin
            "yes (web)",                            # Capacitor bridge
            "1830 × 896", "1829.5 × 896.2", "DPR 1.05",  # Viewport, combined
            "0 / 0 / 0 / 0",                        # Safe-area insets
            "landscape-primary",                    # Orientation
            "Chrome 151", "Windows 10",              # Browser, readable rendering
            "user_films", "not yet attempted",      # Account sync — pending, named
            "notify_prefs", "FAILED",
            "Could not find the", "excluded_moments", "schema cache",  # Account sync — failure detail (html-escaped quotes)
            "retry scheduled for notify_prefs",     # Console tail (log line)
            "sync queue drained",
            "weird sync line with no colon at all", # unrecognised line -> Other, verbatim
            "Built at", "2026-07-15T04:00:00.000Z", # unconsumed Identity field -> Other
            "Protocol", "https:",                   # unconsumed Identity field -> Other
            "visualViewport offsetTop",              # unconsumed Geometry field -> Other
            "documentElement clientHeight",
        ):
            self.assertIn(token, html, f"missing token: {token!r}")

    def test_diagnostics_raw_block_kept_byte_for_byte_in_text_part(self):
        store = InMemoryStore()
        row = _row(diagnostics=DIAG_BLOCK)
        d = render_digest([row], store)
        self.assertIn(DIAG_BLOCK, d["text"])

    def test_no_diagnostics_no_diagnostics_panel(self):
        store = InMemoryStore()
        row = _row(category="suggestion", diagnostics=None)
        d = render_digest([row], store)
        self.assertNotIn("Diagnostics", d["html"])

    def test_diagnostics_account_sync_all_ok_when_nothing_failed_or_pending(self):
        store = InMemoryStore()
        clean_block = ("=== Cascade diagnostics ===\n\n-- Identity --\nOrigin: https://cascademovies.com\n"
                       "\n-- Account sync --\ncascades: OK (2026-07-16T09:00:00.000Z)\n"
                       "\n-- Log tail (0) --\n(empty)\n")
        row = _row(diagnostics=clean_block)
        d = render_digest([row], store)
        self.assertIn("All OK", d["html"])
        self.assertIn("empty", d["html"])


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
