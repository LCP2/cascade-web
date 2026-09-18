"""Unit tests for the standalone metrics report email (CAS-1021).

Fixture rows for rendering: an empty view, a zero-denominator funnel, and a normal funnel — per
the ticket's own AC1. Also covers gather_view_rows's per-view fallback and the offline
--dry-run CLI path.

Run:  python -m unittest monitor.tests.test_metrics_report
"""
import datetime
import unittest
import unittest.mock

from monitor import metrics_report as mr


class RenderViewTable(unittest.TestCase):
    def test_unavailable_view_says_so(self):
        html = mr.render_view_table("Sessions", None)
        self.assertIn("unavailable", html)

    def test_empty_view_says_no_data(self):
        html = mr.render_view_table("Sessions", [])
        self.assertIn("no data", html)

    def test_zero_denominator_funnel_shows_dash_not_nan(self):
        rows = [{"step": "splash_shown", "shown": 0, "continued": 0, "skipped": 0, "drop_pct": None}]
        html = mr.render_view_table("Onboarding funnel", rows)
        self.assertIn("–", html)
        for bad in ("NaN", "Infinity", "inf"):
            self.assertNotIn(bad, html)

    def test_normal_funnel_renders_values(self):
        rows = [{"step": "v2_done", "shown": 200, "continued": 150, "skipped": 10, "drop_pct": 25.0}]
        html = mr.render_view_table("Onboarding funnel", rows)
        self.assertIn("v2_done", html)
        self.assertIn("200", html)
        self.assertIn("25.0", html)


class RenderReport(unittest.TestCase):
    def test_onboarding_funnel_table_comes_first(self):
        view_rows = {
            "analytics_onboarding_funnel": [{"step": "v2_done", "shown": 1, "continued": 1,
                                             "skipped": 0, "drop_pct": 0.0}],
            "analytics_sessions": [{"client_key": "abc", "session": "s1"}],
        }
        report = mr.render_report(view_rows, datetime.date(2026, 9, 17))
        html = report["html"]
        self.assertLess(html.index("Onboarding funnel"), html.index("Sessions"))
        self.assertEqual(report["subject"], "Cascade metrics — 2026-09-17")

    def test_missing_views_all_render_unavailable(self):
        report = mr.render_report({}, datetime.date(2026, 9, 17))
        self.assertEqual(report["html"].count("unavailable"), len(mr.VIEWS))

    def test_no_nan_or_infinity_anywhere_in_a_mixed_report(self):
        view_rows = {
            "analytics_onboarding_funnel": [
                {"step": "splash_shown", "shown": 0, "continued": 0, "skipped": 0, "drop_pct": None},
                {"step": "v2_done", "shown": 50, "continued": 40, "skipped": 5, "drop_pct": 20.0},
            ],
            "analytics_sessions": [],
        }
        html = mr.render_report(view_rows, datetime.date(2026, 9, 17))["html"]
        for bad in ("NaN", "Infinity", "inf"):
            self.assertNotIn(bad, html)


class GatherViewRows(unittest.TestCase):
    def test_a_failing_view_does_not_take_down_the_others(self):
        class FlakyStore:
            def fetch_view(self, name):
                if name == "analytics_retention":
                    raise RuntimeError("HTTP 404")
                return [{"ok": name}]

        rows = mr.gather_view_rows(FlakyStore())
        self.assertIsNone(rows["analytics_retention"])
        self.assertEqual(rows["analytics_sessions"], [{"ok": "analytics_sessions"}])
        self.assertEqual(len(rows), len(mr.VIEWS))


class DryRunCli(unittest.TestCase):
    """AC2: python -m monitor.metrics_report --dry-run exits 0 and prints the funnel table first."""

    def test_dry_run_with_no_secrets_exits_zero_and_prints_onboarding_first(self):
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            with unittest.mock.patch("builtins.print") as mock_print:
                code = mr.main(["--dry-run"])
        self.assertEqual(code, 0)
        printed = "\n".join(str(c.args[0]) for c in mock_print.call_args_list if c.args)
        self.assertIn("Onboarding funnel", printed)
        self.assertLess(printed.index("Onboarding funnel"), printed.index("Sessions"))
        for bad in ("NaN", "Infinity", "inf"):
            self.assertNotIn(bad, printed)

    def test_missing_secrets_alone_auto_dry_runs(self):
        """No --dry-run flag, but no secrets either — must still exit 0 and send nothing."""
        with unittest.mock.patch.dict("os.environ", {}, clear=True):
            code = mr.main([])
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
