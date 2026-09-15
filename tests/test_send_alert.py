"""CAS-973 — the workflow-failure alert script (scripts/send_alert.py).

Every network seam is monkeypatched directly on urllib.request, so no test here makes a live
HTTP call (same pattern as monitor/tests/test_emailer.py's SendViaResendTests).
"""
import io
import os
import sys
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import send_alert  # noqa: E402


class BuildMessageTests(unittest.TestCase):
    def test_subject_names_the_workflow(self):
        subject, _ = send_alert.build_message("daily", "https://x.test/runs/1", "refresh", "Build", "")
        self.assertEqual(subject, "[Cascade ALERT] daily failed")

    def test_body_carries_workflow_run_job_and_step(self):
        _, text = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine invariants", "")
        self.assertIn("Workflow: qa", text)
        self.assertIn("https://x.test/runs/9", text)
        self.assertIn("Failing job: engine", text)
        self.assertIn("Failing step: Engine invariants", text)

    def test_unknown_job_and_step_are_stated_honestly(self):
        _, text = send_alert.build_message("qa", "https://x.test/runs/9", "", "", "")
        self.assertIn("Failing job: (unknown)", text)
        self.assertIn("Failing step: (unknown)", text)

    def test_log_tail_included_only_when_present(self):
        _, without = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine", "")
        self.assertNotIn("log", without.lower())
        _, with_tail = send_alert.build_message("qa", "https://x.test/runs/9", "engine", "Engine", "boom\nline2")
        self.assertIn("boom", with_tail)
        self.assertIn("line2", with_tail)


class FindFailureTests(unittest.TestCase):
    def test_reads_failed_job_step_and_log_tail(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = (
            b'{"jobs": [{"id": 1, "name": "ok", "conclusion": "success", "steps": []}, '
            b'{"id": 2, "name": "engine", "conclusion": "failure", '
            b'"steps": [{"name": "Build", "conclusion": "success"}, '
            b'{"name": "Engine invariants", "conclusion": "failure"}]}]}'
        )
        jobs_resp.__enter__.return_value = jobs_resp
        logs_resp = mock.MagicMock()
        logs_resp.read.return_value = "\n".join(f"line{i}" for i in range(50)).encode("utf-8")
        logs_resp.__enter__.return_value = logs_resp

        with mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, logs_resp]):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")

        self.assertEqual(job, "engine")
        self.assertEqual(step, "Engine invariants")
        self.assertNotIn("line0", tail)          # only the last 40 lines
        self.assertIn("line49", tail)

    def test_no_failed_job_returns_blanks(self):
        resp = mock.MagicMock()
        resp.read.return_value = b'{"jobs": [{"id": 1, "name": "ok", "conclusion": "success", "steps": []}]}'
        resp.__enter__.return_value = resp
        with mock.patch("urllib.request.urlopen", return_value=resp):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")
        self.assertEqual((job, step, tail), ("", "", ""))

    def test_api_error_degrades_to_blanks_instead_of_raising(self):
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("boom")):
            job, step, tail = send_alert.find_failure("o/r", "123", "tok")
        self.assertEqual((job, step, tail), ("", "", ""))


class MainTests(unittest.TestCase):
    def _env(self, **overrides):
        env = {
            "CASCADE_ALERT_TO": "lee@example.test",
            "RESEND_API_KEY": "key",
            "WORKFLOW_NAME": "daily",
            "GITHUB_REPOSITORY": "LCP2/cascade-web",
            "GITHUB_RUN_ID": "42",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_TOKEN": "tok",
        }
        env.update(overrides)
        return env

    def test_no_alert_to_sends_nothing_and_exits_0(self):
        with mock.patch.dict(os.environ, self._env(CASCADE_ALERT_TO=""), clear=True), \
             mock.patch("urllib.request.urlopen") as urlopen:
            rc = send_alert.main()
        self.assertEqual(rc, 0)
        urlopen.assert_not_called()

    def test_no_resend_key_sends_nothing_and_exits_0(self):
        with mock.patch.dict(os.environ, self._env(RESEND_API_KEY=""), clear=True), \
             mock.patch("urllib.request.urlopen") as urlopen:
            rc = send_alert.main()
        self.assertEqual(rc, 0)
        urlopen.assert_not_called()

    def test_sends_exactly_one_email_when_configured(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        send_resp = mock.MagicMock()
        send_resp.read.return_value = b'{"id": "abc"}'
        send_resp.__enter__.return_value = send_resp

        with mock.patch.dict(os.environ, self._env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, send_resp]) as urlopen:
            rc = send_alert.main()

        self.assertEqual(rc, 0)
        self.assertEqual(urlopen.call_count, 2)  # one jobs lookup, one Resend send
        send_req = urlopen.call_args_list[-1][0][0]
        self.assertEqual(send_req.full_url, send_alert.RESEND_ENDPOINT)

    def test_resend_http_error_is_reported_and_exits_nonzero(self):
        jobs_resp = mock.MagicMock()
        jobs_resp.read.return_value = b'{"jobs": []}'
        jobs_resp.__enter__.return_value = jobs_resp
        err = urllib.error.HTTPError(
            url=send_alert.RESEND_ENDPOINT, code=403, msg="Forbidden",
            hdrs={"Content-Type": "text/html"}, fp=io.BytesIO(b"blocked"),
        )
        with mock.patch.dict(os.environ, self._env(), clear=True), \
             mock.patch("urllib.request.urlopen", side_effect=[jobs_resp, err]):
            rc = send_alert.main()
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main()
