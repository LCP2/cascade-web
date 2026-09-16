"""Unit tests for the nightly health assertions (CAS-974, CAS-988).

One passing and one failing fixture per check, plus a dedicated test for the deliberately
shrunken movies.json fixture (AC3) and the offline --dry-run CLI path (AC1).

Run:  python -m unittest monitor.tests.test_health
"""
import datetime
import json
import os
import unittest
import unittest.mock

from monitor import health
from monitor.catalogue import load_catalogue_file, movies_of

_FIXTURES = os.path.join(os.path.dirname(__file__), os.pardir, "fixtures")


def _movies(n, scored=0, tmdb_ids=None, titles=None, cinema_dates=None, statuses=None):
    """n synthetic records, `scored` of them carrying a wm_user_rating. Any of tmdb_ids/titles/
    cinema_dates/statuses may override individual records (by index) to build a bad fixture."""
    out = []
    for i in range(n):
        out.append({
            "tmdb_id": (tmdb_ids or {}).get(i, 1000 + i),
            "title": (titles or {}).get(i, f"Film {i}"),
            "cinema_date": (cinema_dates or {}).get(i, "2026-01-01"),
            "status": (statuses or {}).get(i, ["in_cinema"]),
            "wm_user_rating": 8.0 if i < scored else None,
            "wm_critic_score": None,
        })
    return out


class CatalogueSize(unittest.TestCase):
    def test_pass_above_floor_and_within_drop(self):
        c = health.check_catalogue_size(_movies(5600), _movies(5580))
        self.assertTrue(c["ok"])

    def test_fail_below_floor(self):
        c = health.check_catalogue_size(_movies(100), _movies(100))
        self.assertFalse(c["ok"])
        self.assertIn("100", c["detail"])

    def test_fail_more_than_five_percent_drop(self):
        c = health.check_catalogue_size(_movies(5600), _movies(6500))
        self.assertFalse(c["ok"])


class CatalogueIntegrity(unittest.TestCase):
    def test_pass_clean_catalogue(self):
        c = health.check_catalogue_integrity(_movies(50))
        self.assertTrue(c["ok"])

    def test_fail_missing_title_and_duplicate_id(self):
        bad = _movies(5, titles={0: ""}, tmdb_ids={4: 1001})   # record 4 collides with record 1
        c = health.check_catalogue_integrity(bad)
        self.assertFalse(c["ok"])
        self.assertEqual(c["value"]["bad"], 1)
        self.assertEqual(c["value"]["duplicates"], 1)


class TmdbFetch(unittest.TestCase):
    def test_pass_calls_no_errors(self):
        c = health.check_tmdb_fetch({"calls": 5600, "errors": 0})
        self.assertTrue(c["ok"])

    def test_fail_has_errors(self):
        c = health.check_tmdb_fetch({"calls": 5600, "errors": 3})
        self.assertFalse(c["ok"])

    def test_unknown_when_absent(self):
        c = health.check_tmdb_fetch(None)
        self.assertIsNone(c["ok"])
        self.assertEqual(c["status"], "unknown")

    def test_pass_not_found_404s_are_not_an_outage(self):
        # CAS-997 AC4: the real daily.yml run 35059055079 shape — 13 not-found across 5862 calls,
        # 0 other errors, must pass.
        c = health.check_tmdb_fetch({"calls": 5862, "errors": 0, "not_found": 13})
        self.assertTrue(c["ok"])

    def test_fail_one_other_error_alongside_not_found(self):
        c = health.check_tmdb_fetch({"calls": 5862, "errors": 1, "not_found": 13})
        self.assertFalse(c["ok"])

    def test_fail_not_found_above_two_percent(self):
        c = health.check_tmdb_fetch({"calls": 1000, "errors": 0, "not_found": 21})
        self.assertFalse(c["ok"])


class OscarbaseFetch(unittest.TestCase):
    def test_pass_calls_no_errors(self):
        c = health.check_oscarbase_fetch({"calls": 20, "errors": 0})
        self.assertTrue(c["ok"])

    def test_fail_zero_calls(self):
        c = health.check_oscarbase_fetch({"calls": 0, "errors": 0})
        self.assertFalse(c["ok"])


class WatchmodeFetch(unittest.TestCase):
    def test_pass_calls_no_errors_credits_ok(self):
        c = health.check_watchmode_fetch(
            {"calls": 40, "errors": 0, "remaining_monthly_credits": 30000}, quota=40000)
        self.assertTrue(c["ok"])

    def test_fail_low_remaining_credits(self):
        # quota 10000 -> floor 1500 (15%); 100 remaining is below it.
        c = health.check_watchmode_fetch(
            {"calls": 40, "errors": 0, "remaining_monthly_credits": 100}, quota=10000)
        self.assertFalse(c["ok"])

    def test_fail_has_errors(self):
        c = health.check_watchmode_fetch(
            {"calls": 40, "errors": 2, "remaining_monthly_credits": 30000}, quota=40000)
        self.assertFalse(c["ok"])

    def test_floor_reads_from_the_passed_in_quota_not_a_hardcoded_plan_size(self):
        # AC5: quota 40000 -> floor 6000. 6500 remaining clears it, 5500 doesn't.
        clears = health.check_watchmode_fetch(
            {"calls": 40, "errors": 0, "remaining_monthly_credits": 6500}, quota=40000)
        below = health.check_watchmode_fetch(
            {"calls": 40, "errors": 0, "remaining_monthly_credits": 5500}, quota=40000)
        self.assertEqual(clears["threshold"], 6000)
        self.assertTrue(clears["ok"])
        self.assertFalse(below["ok"])


class WatchmodePace(unittest.TestCase):
    """AC1/AC2/AC3 — extrapolate the cycle's recent daily burn to the reset date."""

    def _cycle(self, days, quota=10000, cycle_end="2026-10-12"):
        return {"cycle_start": "2026-09-12", "cycle_end": cycle_end, "quota": quota,
               "spent": sum(days.values()), "updated_at": "2026-09-15", "days": days}

    def test_fail_pace_exceeds_quota_before_reset(self):
        # 1380 spent over 3 days (460/day average), 27 days to reset -> projects to 13800 > 10000.
        cycle = self._cycle({"2026-09-12": 460, "2026-09-13": 460, "2026-09-14": 460})
        c = health.check_watchmode_pace(cycle, datetime.date(2026, 9, 15))
        self.assertFalse(c["ok"])
        self.assertIn("2026-10-03", c["detail"])   # the projected exhaustion date

    def test_pass_pace_stays_under_quota(self):
        # 750 spent over 3 days (250/day average), 27 days to reset -> projects to 7500 < 10000.
        cycle = self._cycle({"2026-09-12": 250, "2026-09-13": 250, "2026-09-14": 250})
        c = health.check_watchmode_pace(cycle, datetime.date(2026, 9, 15))
        self.assertTrue(c["ok"])

    def test_unknown_with_fewer_than_three_days_of_cycle_data(self):
        cycle = self._cycle({"2026-09-13": 460, "2026-09-14": 460})
        c = health.check_watchmode_pace(cycle, datetime.date(2026, 9, 15))
        self.assertIsNone(c["ok"])

    def test_unknown_when_no_cycle_available(self):
        c = health.check_watchmode_pace(None, datetime.date(2026, 9, 15))
        self.assertIsNone(c["ok"])


class ScoreCoverage(unittest.TestCase):
    def test_pass_at_or_above_ninety_percent(self):
        c = health.check_score_coverage(_movies(100, scored=95), _movies(100, scored=100))
        self.assertTrue(c["ok"])

    def test_fail_below_ninety_percent(self):
        c = health.check_score_coverage(_movies(100, scored=50), _movies(100, scored=100))
        self.assertFalse(c["ok"])

    def test_unknown_with_no_previous_scores(self):
        c = health.check_score_coverage(_movies(100, scored=50), _movies(100, scored=0))
        self.assertIsNone(c["ok"])


class EmailSend(unittest.TestCase):
    def test_pass_all_delivered(self):
        c = health.check_email_send({"attempted": 3, "delivered": 3, "errors": 0})
        self.assertTrue(c["ok"])

    def test_fail_has_errors(self):
        c = health.check_email_send({"attempted": 3, "delivered": 2, "errors": 1})
        self.assertFalse(c["ok"])

    def test_unknown_when_nothing_attempted(self):
        c = health.check_email_send(None)
        self.assertIsNone(c["ok"])


class PushSend(unittest.TestCase):
    def test_pass_all_delivered(self):
        c = health.check_push_send({"attempted": 2, "delivered": 2, "errors": 0}, apns_configured=True)
        self.assertTrue(c["ok"])

    def test_fail_has_errors(self):
        c = health.check_push_send({"attempted": 2, "delivered": 1, "errors": 1}, apns_configured=True)
        self.assertFalse(c["ok"])

    def test_skipped_when_apns_not_configured(self):
        c = health.check_push_send({"attempted": 2, "delivered": 2, "errors": 0}, apns_configured=False)
        self.assertEqual(c["status"], "skipped")
        self.assertIsNone(c["ok"])


class UsageEventsInsert(unittest.TestCase):
    def test_pass_canary_row_landed(self):
        c = health.check_usage_events_insert({"ok": True, "detail": "HTTP 201"})
        self.assertTrue(c["ok"])

    def test_fail_insert_rejected(self):
        c = health.check_usage_events_insert({"ok": False, "detail": "HTTP 403 — RLS"})
        self.assertFalse(c["ok"])

    def test_unknown_with_no_credentials(self):
        c = health.check_usage_events_insert(None)
        self.assertIsNone(c["ok"])

    def test_ac3_fails_loud_naming_the_missing_credential(self):
        probe = health.probe_usage_events_insert(None, None)
        c = health.check_usage_events_insert(probe)
        self.assertFalse(c["ok"])
        self.assertEqual(c["status"], "fail")
        self.assertIn("not configured: SUPABASE_URL", c["detail"])
        self.assertIn("SUPABASE_ANON_KEY", c["detail"])


class AuthSignin(unittest.TestCase):
    def test_pass_session_returned(self):
        c = health.check_auth_signin({"ok": True, "detail": "session returned."})
        self.assertTrue(c["ok"])

    def test_fail_no_session(self):
        c = health.check_auth_signin({"ok": False, "detail": "HTTP 400 — invalid_grant"})
        self.assertFalse(c["ok"])

    def test_unknown_with_no_credentials(self):
        c = health.check_auth_signin(None)
        self.assertIsNone(c["ok"])

    def test_ac3_fails_loud_naming_the_missing_credential(self):
        probe = health.probe_auth_signin("https://x.test", "anon-key", None, None)
        c = health.check_auth_signin(probe)
        self.assertFalse(c["ok"])
        self.assertEqual(c["status"], "fail")
        self.assertEqual(c["detail"], "not configured: SUPABASE_SERVICE_ROLE_KEY, CASCADE_CANARY_EMAIL")

    def test_ac3_fails_loud_naming_only_the_missing_service_role_key(self):
        probe = health.probe_auth_signin("https://x.test", "anon-key", None, "canary@x.test")
        c = health.check_auth_signin(probe)
        self.assertFalse(c["ok"])
        self.assertEqual(c["status"], "fail")
        self.assertEqual(c["detail"], "not configured: SUPABASE_SERVICE_ROLE_KEY")

    def test_ac1_generate_link_then_verify_yields_a_working_session(self):
        calls = []

        def fake_post(url, headers, payload, timeout=15):
            calls.append(url)
            if url.endswith("/auth/v1/admin/generate_link"):
                self.assertEqual(headers.get("apikey"), "service-role-key")
                self.assertEqual(payload, {"type": "magiclink", "email": "canary@x.test"})
                return 200, json.dumps({"properties": {"hashed_token": "HASHED123"}})
            if url.endswith("/auth/v1/verify"):
                self.assertEqual(headers.get("apikey"), "anon-key")
                self.assertEqual(payload, {"type": "magiclink", "token_hash": "HASHED123"})
                return 200, json.dumps({"access_token": "TOKEN123"})
            raise AssertionError(f"unexpected POST {url}")

        with unittest.mock.patch("monitor.health._post_json", side_effect=fake_post):
            probe = health.probe_auth_signin(
                "https://x.test", "anon-key", "service-role-key", "canary@x.test")

        self.assertEqual(calls, [
            "https://x.test/auth/v1/admin/generate_link", "https://x.test/auth/v1/verify"])
        self.assertTrue(probe["ok"])
        self.assertEqual(probe["token"], "TOKEN123")


class UsageWindowSession(unittest.TestCase):
    """CAS-996 AC2: the CAS-985 usage_events reads mint their session the same passwordless way
    and use the returned access_token, not a stored password."""

    def test_ac2_usage_window_reads_use_the_minted_access_token(self):
        def fake_post(url, headers, payload, timeout=15):
            if url.endswith("/auth/v1/admin/generate_link"):
                return 200, json.dumps({"properties": {"hashed_token": "HASHED123"}})
            if url.endswith("/auth/v1/verify"):
                return 200, json.dumps({"access_token": "TOKEN123"})
            raise AssertionError(f"unexpected POST {url}")

        seen_auth_headers = []

        def fake_get(url, headers, timeout=15):
            seen_auth_headers.append(headers.get("Authorization"))
            return 200, "[]"

        now = datetime.datetime(2026, 9, 16, tzinfo=datetime.timezone.utc)
        with unittest.mock.patch("monitor.health._post_json", side_effect=fake_post), \
             unittest.mock.patch("monitor.health._get_json", side_effect=fake_get):
            window = health.probe_usage_window(
                "https://x.test", "anon-key", "service-role-key", "canary@x.test", now)

        self.assertEqual(window, {"rows24": [], "rows_prev": []})
        self.assertEqual(seen_auth_headers, ["Bearer TOKEN123", "Bearer TOKEN123"])

    def test_ac3_fails_loud_naming_only_the_missing_service_role_key(self):
        window = health.probe_usage_window(
            "https://x.test", "anon-key", None, "canary@x.test", datetime.datetime.now())
        c = health.check_client_error_rate(window)
        self.assertFalse(c["ok"])
        self.assertEqual(c["status"], "fail")
        self.assertEqual(c["detail"], "not configured: SUPABASE_SERVICE_ROLE_KEY")


def _rows(n, type_="app_open", client_prefix="device", data=None):
    return [{"type": type_, "client_key": f"{client_prefix}-{i}", "data": data} for i in range(n)]


class ClientErrorRate(unittest.TestCase):
    """CAS-985: client_error + client_rejection as a share of app_open, red above 5% or 20 rows."""

    def test_pass_low_error_rate(self):
        window = {"rows24": _rows(100) + _rows(2, "client_error"), "rows_prev": []}
        c = health.check_client_error_rate(window)
        self.assertTrue(c["ok"])
        self.assertEqual(c["value"], 2)

    def test_fail_over_five_percent(self):
        window = {"rows24": _rows(100) + _rows(10, "client_error"), "rows_prev": []}
        c = health.check_client_error_rate(window)
        self.assertFalse(c["ok"])

    def test_fail_over_twenty_rows_even_under_five_percent(self):
        # 21 of 1000 is 2.1%, well under the 5% ceiling, but over the 20-row absolute ceiling.
        window = {"rows24": _rows(1000) + _rows(21, "client_error"), "rows_prev": []}
        c = health.check_client_error_rate(window)
        self.assertFalse(c["ok"])

    def test_top_messages_named_in_detail(self):
        window = {"rows24": _rows(100) + _rows(3, "client_error", data={"message": "sync_failed boom"}),
                  "rows_prev": []}
        c = health.check_client_error_rate(window)
        self.assertIn("sync_failed boom", c["detail"])

    def test_unknown_under_fifty_app_open_rows(self):
        window = {"rows24": _rows(10) + _rows(5, "client_error"), "rows_prev": []}
        c = health.check_client_error_rate(window)
        self.assertIsNone(c["ok"])

    def test_unknown_with_no_credentials(self):
        c = health.check_client_error_rate(None)
        self.assertIsNone(c["ok"])

    def test_unknown_when_probe_errored(self):
        c = health.check_client_error_rate({"error": "canary sign-in failed (HTTP 400)."})
        self.assertIsNone(c["ok"])
        self.assertIn("canary sign-in failed", c["detail"])

    def test_ac3_fails_loud_naming_the_missing_credential(self):
        window = health.probe_usage_window(None, None, None, None, datetime.datetime.now())
        c = health.check_client_error_rate(window)
        self.assertFalse(c["ok"])
        self.assertEqual(c["status"], "fail")
        self.assertIn("not configured: SUPABASE_URL", c["detail"])


class EmptyAccountRate(unittest.TestCase):
    """CAS-985: signin_empty_account as a share of all real-account sign-ins, red above 10%."""

    def test_pass_low_empty_rate(self):
        window = {"rows24": _rows(60) + _rows(95, "signin_returning") + _rows(5, "signin_empty_account"),
                  "rows_prev": []}
        c = health.check_empty_account_rate(window)
        self.assertTrue(c["ok"])
        self.assertEqual(c["value"], 5)

    def test_fail_over_ten_percent(self):
        window = {"rows24": _rows(60) + _rows(80, "signin_returning") + _rows(20, "signin_empty_account"),
                  "rows_prev": []}
        c = health.check_empty_account_rate(window)
        self.assertFalse(c["ok"])

    def test_unknown_under_fifty_app_open_rows(self):
        window = {"rows24": _rows(10) + _rows(1, "signin_empty_account"), "rows_prev": []}
        c = health.check_empty_account_rate(window)
        self.assertIsNone(c["ok"])

    def test_unknown_with_no_credentials(self):
        c = health.check_empty_account_rate(None)
        self.assertIsNone(c["ok"])


class ActivityFloor(unittest.TestCase):
    """CAS-985: distinct devices with an app_open in the last 24h; red at zero when yesterday wasn't."""

    def test_pass_devices_active_both_days(self):
        window = {"rows24": _rows(60), "rows_prev": _rows(55)}
        c = health.check_activity_floor(window)
        self.assertTrue(c["ok"])
        self.assertEqual(c["value"], 60)

    def test_fail_zero_today_after_nonzero_yesterday(self):
        window = {"rows24": _rows(60, "signin_returning"), "rows_prev": _rows(55)}
        c = health.check_activity_floor(window)
        self.assertFalse(c["ok"])
        self.assertEqual(c["value"], 0)

    def test_unknown_under_fifty_app_open_rows(self):
        window = {"rows24": _rows(10), "rows_prev": _rows(10)}
        c = health.check_activity_floor(window)
        self.assertIsNone(c["ok"])

    def test_unknown_with_no_credentials(self):
        c = health.check_activity_floor(None)
        self.assertIsNone(c["ok"])


class ShrunkenCatalogueFixture(unittest.TestCase):
    """AC3: a deliberately shrunken movies.json fixture fails catalogue_size with the actual
    count in the message. monitor/fixtures/today.json (6 records) already IS such a fixture."""

    def test_bundled_today_fixture_fails_catalogue_size_with_real_count(self):
        movies = movies_of(load_catalogue_file(os.path.join(_FIXTURES, "today.json")))
        c = health.check_catalogue_size(movies, [])
        self.assertFalse(c["ok"])
        self.assertIn(str(len(movies)), c["detail"])


class BuildReport(unittest.TestCase):
    def test_ok_false_when_any_check_fails(self):
        checks = [health.check_catalogue_size(_movies(100), _movies(100)),
                  health.check_email_send(None)]
        report = health.build_report(checks, "2026-09-15T00:00:00+00:00")
        self.assertFalse(report["ok"])

    def test_ok_true_when_only_unknowns(self):
        checks = [health.check_catalogue_size(_movies(5600), []),
                  health.check_email_send(None)]
        report = health.build_report(checks, "2026-09-15T00:00:00+00:00")
        self.assertTrue(report["ok"])


class RunChecksScoping(unittest.TestCase):
    """CAS-993: daily.yml and alerts.yml each assert a different subset of CHECK_NAMES now."""

    def test_names_none_returns_every_check_in_order(self):
        checks = health.run_checks(
            today_movies=_movies(5600), prev_movies=_movies(5580),
            stats={"email": {"attempted": 1, "delivered": 1, "errors": 0}},
            usage_probe=None, auth_probe=None, apns_configured=False,
            wm_cycle={"quota": 40000}, today=datetime.date(2026, 9, 15), usage_window=None)
        self.assertEqual([c["name"] for c in checks], list(health.CHECK_NAMES))

    def test_alert_scope_only_computes_email_and_push(self):
        checks = health.run_checks(
            stats={"email": {"attempted": 1, "delivered": 1, "errors": 0},
                  "push": {"attempted": 1, "delivered": 1, "errors": 0}},
            apns_configured=True, names=health.ALERT_CHECK_NAMES)
        self.assertEqual([c["name"] for c in checks], ["email_send", "push_send"])
        self.assertTrue(all(c["ok"] for c in checks))

    def test_daily_scope_excludes_email_and_push(self):
        checks = health.run_checks(
            today_movies=_movies(5600), prev_movies=_movies(5580), stats={},
            usage_probe=None, auth_probe=None, apns_configured=False,
            wm_cycle={"quota": 40000}, today=datetime.date(2026, 9, 15), usage_window=None,
            names=health.DAILY_CHECK_NAMES)
        names = [c["name"] for c in checks]
        self.assertNotIn("email_send", names)
        self.assertNotIn("push_send", names)
        self.assertIn("catalogue_size", names)


class MergeReport(unittest.TestCase):
    """CAS-993: a second same-day scoped run adds its checks rather than overwriting the first."""

    def test_same_day_merges_by_name(self):
        existing = {"checked_at": "2026-09-15T20:00:00+00:00",
                    "checks": [health.check_catalogue_size(_movies(5600), _movies(5580))]}
        new_checks = [health.check_email_send({"attempted": 1, "delivered": 1, "errors": 0})]
        merged = health.merge_report(existing, new_checks, "2026-09-15T03:17:00+00:00")
        self.assertEqual({c["name"] for c in merged["checks"]}, {"catalogue_size", "email_send"})
        self.assertTrue(merged["ok"])

    def test_same_day_replaces_a_check_with_the_same_name(self):
        stale = health.check_email_send({"attempted": 1, "delivered": 0, "errors": 1})   # fail
        existing = {"checked_at": "2026-09-15T03:00:00+00:00", "checks": [stale]}
        fresh = [health.check_email_send({"attempted": 1, "delivered": 1, "errors": 0})]   # pass
        merged = health.merge_report(existing, fresh, "2026-09-15T03:17:00+00:00")
        self.assertEqual(len(merged["checks"]), 1)
        self.assertTrue(merged["checks"][0]["ok"])

    def test_earlier_calendar_day_starts_fresh(self):
        existing = {"checked_at": "2026-09-14T20:00:00+00:00",
                    "checks": [health.check_catalogue_size(_movies(100), _movies(100))]}  # fail
        new_checks = [health.check_email_send({"attempted": 1, "delivered": 1, "errors": 0})]
        merged = health.merge_report(existing, new_checks, "2026-09-15T03:17:00+00:00")
        self.assertEqual([c["name"] for c in merged["checks"]], ["email_send"])
        self.assertTrue(merged["ok"])

    def test_no_existing_report_starts_fresh(self):
        new_checks = [health.check_email_send({"attempted": 1, "delivered": 1, "errors": 0})]
        merged = health.merge_report(None, new_checks, "2026-09-15T03:17:00+00:00")
        self.assertEqual([c["name"] for c in merged["checks"]], ["email_send"])


class ScopedCliExitCode(unittest.TestCase):
    """A merged-in failure from the OTHER scope's earlier run must not fail THIS run."""

    def test_alerts_scope_ignores_a_daily_failure_already_in_the_file(self):
        out_path = os.path.join(os.path.dirname(__file__), "_health_scope_cli.json")
        self.addCleanup(lambda: os.path.exists(out_path) and os.remove(out_path))
        json.dump({"checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "checks": [health.check_catalogue_size(_movies(100), _movies(100))],  # fail
                  "ok": False},
                 open(out_path, "w", encoding="utf-8"))
        # Isolated from the real state/run_stats.json — a same-day real daily.yml run committing
        # real "email"/"push" data would otherwise make this test's outcome depend on repo state.
        with unittest.mock.patch("monitor.health.runstats.load", return_value={"date": "x"}):
            code = health.main(["--scope", "alerts", "--out", out_path])
        self.assertEqual(code, 0)   # push_send/email_send report "unknown" with no stats/env configured
        report = json.load(open(out_path, encoding="utf-8"))
        self.assertIn("catalogue_size", {c["name"] for c in report["checks"]})
        self.assertIn("email_send", {c["name"] for c in report["checks"]})


class DryRunCli(unittest.TestCase):
    """AC1: python -m monitor.health --dry-run runs offline against fixtures and exits 0."""

    def test_dry_run_exits_zero_and_writes_report(self):
        out_path = os.path.join(os.path.dirname(__file__), "_health_dry_run.json")
        self.addCleanup(lambda: os.path.exists(out_path) and os.remove(out_path))
        code = health.main(["--dry-run", "--out", out_path])
        self.assertEqual(code, 0)
        report = json.load(open(out_path, encoding="utf-8"))
        self.assertTrue(report["ok"])
        self.assertEqual(len(report["checks"]), len(health.CHECK_NAMES))


if __name__ == "__main__":
    unittest.main()
