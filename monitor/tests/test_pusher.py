"""Unit tests for the APNs push channel (CAS-465).

Run:  python -m unittest monitor.tests.test_pusher
"""
import os
import unittest
from unittest import mock

from monitor import pusher
from monitor.matching import Hit
from monitor.pusher import push_copy, send_via_apns
from monitor.transitions import Transition

APNS_ENV_VARS = ("APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY", "APNS_BUNDLE_ID")


def _hit(title, moment, cascade="Drama rentals"):
    t = Transition(movie_id="1", title=title, moment=moment, services=[], price=None, movie={})
    return Hit(user_id="user-A", cascade_id="c1", cascade_name=cascade, transition=t)


class NoSecretsNoOp(unittest.TestCase):
    """Mirrors emailer.py's degrade-gracefully-with-no-RESEND_API_KEY convention: a monitor run
    with no APNs configured (true until Lee adds the GitHub Actions secrets) must still complete
    green, never attempting a network call."""

    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {}, clear=False)
        self._env_patch.start()
        for var in APNS_ENV_VARS:
            os.environ.pop(var, None)
        self.addCleanup(self._env_patch.stop)
        self._warned_patch = mock.patch.object(pusher, "_warned_missing_config", False)
        self._warned_patch.start()
        self.addCleanup(self._warned_patch.stop)

    def test_no_op_when_all_unset(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        urlopen.assert_not_called()

    def test_no_op_when_only_some_are_set(self):
        os.environ["APNS_KEY_ID"] = "K1"
        os.environ["APNS_TEAM_ID"] = "T1"
        # APNS_AUTH_KEY / APNS_BUNDLE_ID still unset
        with mock.patch("urllib.request.urlopen") as urlopen:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        urlopen.assert_not_called()

    def test_missing_config_warns_visibly_once(self):
        """CAS-483: a silent False is what let a missing daily.yml env-block hide for three
        tickets' worth of work — the gap must now print, but only once per run, not once per
        device/push, so a real config gap can't drown the log either."""
        with mock.patch("urllib.request.urlopen"), mock.patch("builtins.print") as printed:
            send_via_apns("device-token", "Title", "Body")
            send_via_apns("device-token-2", "Title", "Body")
        warnings = [c for c in printed.call_args_list if "push not configured" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("APNS_KEY_ID", str(warnings[0]))


class RejectedPushWarnsVisibly(unittest.TestCase):
    """CAS-483 acceptance: a non-2xx APNs response must be logged visibly, not swallowed."""

    def setUp(self):
        self._env_patch = mock.patch.dict(os.environ, {
            "APNS_KEY_ID": "K1", "APNS_TEAM_ID": "T1",
            "APNS_AUTH_KEY": "fake-key-not-parsed", "APNS_BUNDLE_ID": "au.com.codynamics.cascade",
        }, clear=False)
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)
        # Bypass real DER/ECDSA signing (covered by test_ecdsa/test_der elsewhere) — this test is
        # only about the HTTP-response-to-log-line path.
        self._token_patch = mock.patch.object(pusher, "_provider_token", return_value="fake-jwt")
        self._token_patch.start()
        self.addCleanup(self._token_patch.stop)

    def test_non_2xx_response_is_logged(self):
        resp = mock.MagicMock()
        resp.status = 410
        resp.__enter__.return_value = resp
        resp.__exit__.return_value = False
        with mock.patch("urllib.request.urlopen", return_value=resp), \
             mock.patch("builtins.print") as printed:
            ok = send_via_apns("device-token", "Title", "Body")
        self.assertFalse(ok)
        warnings = [c for c in printed.call_args_list if "APNs push rejected" in str(c)]
        self.assertEqual(len(warnings), 1)
        self.assertIn("410", str(warnings[0]))


class CopyTemplates(unittest.TestCase):
    """CAS-465 build step 2: copy must match the spec'd templates exactly, and the status-moment
    phrasing must be the bell's own REAL_MOMENT_SAID wording, not a reinvented string."""

    def test_announced(self):
        copy = push_copy(_hit("Dune Three", "announced", cascade="Sci-fi epics"))
        self.assertEqual(copy["title"], "New match for Sci-fi epics")
        self.assertEqual(copy["body"],
                          "Dune Three just joined Cascade — matches your Sci-fi epics agent.")

    def test_status_moments_reuse_the_bells_own_phrasing(self):
        cases = {
            "hits_cinema": "reached a cinema",
            "hits_pvod": "is available to buy",
            "hits_rent": "dropped to a rental price",
            "hits_stream": "landed on streaming",
            "past_opening_weekend": "is past its opening weekend",
        }
        for moment, said in cases.items():
            copy = push_copy(_hit("Fixture Film", moment))
            self.assertEqual(copy["title"], "Fixture Film")
            self.assertEqual(copy["body"], f"Fixture Film {said}.")


if __name__ == "__main__":
    unittest.main()
