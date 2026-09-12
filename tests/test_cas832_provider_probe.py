"""CAS-832 — a provider whose key is REJECTED (401/403, not a quota) degrades the catalogue
silently and indefinitely: CAS-161's per-call defensive bail correctly keeps a title's existing
data on one bad call, but a key that is wrong for good means every enrichment call this run (and
every run after it) hits the same bail, forever, with nothing louder than a warning line in the
log. One cheap probe per provider up front tells "wrong key" (rejected — will not fix itself)
apart from "over quota / rate limited" (throttled — expected on a free tier, self-healing), and
`--build-html` — the exact command CI's build-check/engine jobs and the daily-refresh
commit-retry loop all run — refuses to build at all when a provider is rejected.

Every test here mocks the network. Nothing reaches TMDB or Watchmode.
"""
import io
import unittest
import urllib.error
from unittest import mock

import poc_pipeline as pp


def _http_error(code, body=b""):
    return urllib.error.HTTPError("https://example.invalid/", code, "err", {}, io.BytesIO(body))


class ProviderProbeClassification(unittest.TestCase):
    """Each probe_* makes one call and returns 'ok' | 'throttled' | 'rejected'."""

    def setUp(self):
        for p in (mock.patch.object(pp, "TMDB_KEY", "x"),
                  mock.patch.object(pp, "WATCHMODE_KEY", "x")):
            p.start(); self.addCleanup(p.stop)

    def test_tmdb_401_invalid_key_is_rejected(self):
        # The real event this ticket is about: TMDB's exact observed response.
        with mock.patch.object(pp, "get_json",
                               side_effect=lambda *a, **kw: (_ for _ in ()).throw(
                                   _http_error(401, b'{"status_message":"Invalid API key"}'))):
            self.assertEqual(pp.probe_tmdb(), "rejected")

    def test_tmdb_success_is_ok(self):
        with mock.patch.object(pp, "get_json", return_value={"images": {}}):
            self.assertEqual(pp.probe_tmdb(), "ok")

    def test_watchmode_403_with_no_quota_wording_is_rejected(self):
        def boom(*a, **kw):
            raise _http_error(403, b'{"error":"invalid api key"}')
        with mock.patch.object(pp, "get_json", side_effect=boom):
            self.assertEqual(pp.probe_watchmode(), "rejected")

    def test_watchmode_429_is_throttled(self):
        def boom(*a, **kw):
            raise _http_error(429)
        with mock.patch.object(pp, "get_json", side_effect=boom):
            self.assertEqual(pp.probe_watchmode(), "throttled")


class ProbeProvidersIsGatedOnLive(unittest.TestCase):
    """Without both keys (LIVE), nothing in the pipeline ever calls any provider today. This
    is why OscarBase (CAS-937) is deliberately NOT part of PROVIDERS/probe_providers: it needs no
    credential of its own, and its nightly pass (`enrich_oscarbase_awards_nightly`) is meant to
    run unconditionally, live or sample — the same tolerance `enrich_watchmode_fields_nightly`
    gives a missing Watchmode key. A dev machine or a CI job with no keys set must not gain a
    brand-new real network call to TMDB/Watchmode just because this probe exists."""

    def test_not_live_never_touches_the_network(self):
        with mock.patch.object(pp, "LIVE", False), \
             mock.patch.object(pp, "get_json",
                               side_effect=AssertionError("must not call the network")):
            outcomes = pp.probe_providers()
        self.assertEqual(outcomes, {name: "unconfigured" for name in pp.PROVIDERS})

    def test_live_probes_every_provider(self):
        with mock.patch.object(pp, "LIVE", True), \
             mock.patch.object(pp, "probe_tmdb", return_value="ok"), \
             mock.patch.object(pp, "probe_watchmode", return_value="rejected"):
            outcomes = pp.probe_providers()
        self.assertEqual(outcomes, {"TMDB": "ok", "Watchmode": "rejected"})


class CheckProviderHealth(unittest.TestCase):
    def test_all_ok_returns_zero_silently(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = pp.check_provider_health({"TMDB": "ok", "Watchmode": "ok"})
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), "")

    def test_a_throttled_provider_warns_and_returns_zero(self):
        # AC2: unchanged from today's behaviour — a warning, run continues.
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = pp.check_provider_health({"TMDB": "ok", "Watchmode": "throttled"})
        self.assertEqual(code, 0)
        self.assertIn("Watchmode", out.getvalue())

    def test_a_rejected_provider_returns_nonzero_and_names_it(self):
        with mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = pp.check_provider_health({"TMDB": "rejected", "Watchmode": "ok"})
        self.assertNotEqual(code, 0)
        self.assertIn("TMDB", out.getvalue())


class BuildVersionInfoCarriesProviderStatus(unittest.TestCase):
    """AC3: the build stamp carries a per-provider status field."""

    def test_provider_status_is_included_when_given(self):
        status = {"TMDB": "ok", "Watchmode": "unconfigured"}
        info = pp.build_version_info(status)
        self.assertEqual(info["providers"], status)

    def test_provider_status_is_absent_when_not_given(self):
        info = pp.build_version_info()
        self.assertNotIn("providers", info)


class RunBuildHtmlEntrypoint(unittest.TestCase):
    """AC1 + AC2, end to end through the actual `--build-html` entry point (`run_build_html`,
    called from `python poc_pipeline.py --build-html`)."""

    def test_a_rejected_provider_exits_non_zero_and_never_builds(self):
        outcomes = {"TMDB": "rejected", "Watchmode": "ok"}
        with mock.patch.object(pp, "probe_providers", return_value=outcomes), \
             mock.patch.object(pp, "build_html") as build_html_mock, \
             mock.patch("sys.stdout", new_callable=io.StringIO) as out:
            code = pp.run_build_html()
        self.assertNotEqual(code, 0)
        self.assertIn("TMDB", out.getvalue())
        build_html_mock.assert_not_called()   # never writes index.html/version.json

    def test_a_throttled_provider_exits_zero_and_still_builds(self):
        outcomes = {"TMDB": "ok", "Watchmode": "throttled"}
        with mock.patch.object(pp, "probe_providers", return_value=outcomes), \
             mock.patch.object(pp, "build_html") as build_html_mock:
            code = pp.run_build_html()
        self.assertEqual(code, 0)
        build_html_mock.assert_called_once_with(provider_status=outcomes)


if __name__ == "__main__":
    unittest.main()
