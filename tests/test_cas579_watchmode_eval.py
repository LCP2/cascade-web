"""CAS-766 — the release-date window for cas579_watchmode_eval.py's Q6 field-coverage sample.

Only the pure query-building helpers are exercised here (sample_query_params,
describe_sample_window). The script's main() makes live HTTP calls and calls sys.exit on a
missing WATCHMODE_API_KEY, so it is not imported/run by this test - no live API calls happen.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import cas579_watchmode_eval as wm  # noqa: E402


class SampleQueryParams(unittest.TestCase):
    def test_no_window_set_matches_the_pre_change_discovery_query(self):
        # Pre-CAS-766, Q6's sample was drawn from Q3's disc call: regions=AU, movies,
        # newest-first, limit 250, no date bound. An unparameterised run must still build
        # exactly that request.
        self.assertEqual(wm.sample_query_params(), {
            "regions": "AU", "types": "movie", "sort_by": "release_date_desc", "limit": 250,
        })

    def test_window_env_vars_are_passed_into_the_api_query_when_set(self):
        params = wm.sample_query_params(start="20200101", end="20241231")
        self.assertEqual(params["release_date_start"], "20200101")
        self.assertEqual(params["release_date_end"], "20241231")

    def test_only_start_set_omits_end(self):
        params = wm.sample_query_params(start="20200101")
        self.assertEqual(params["release_date_start"], "20200101")
        self.assertNotIn("release_date_end", params)

    def test_only_end_set_omits_start(self):
        params = wm.sample_query_params(end="20241231")
        self.assertEqual(params["release_date_end"], "20241231")
        self.assertNotIn("release_date_start", params)

    def test_limit_is_unchanged_from_pre_change_behaviour(self):
        self.assertEqual(wm.sample_query_params(start="20200101", end="20241231")["limit"], 250)


class SampleSize(unittest.TestCase):
    def test_sample_size_raised_from_8_to_at_least_40(self):
        self.assertGreaterEqual(wm.SAMPLE_SIZE, 40)


class DescribeSampleWindow(unittest.TestCase):
    def test_no_window_is_named_explicitly(self):
        desc = wm.describe_sample_window(None, None)
        self.assertIn("no window", desc.lower())

    def test_window_names_both_bounds(self):
        desc = wm.describe_sample_window("20200101", "20241231")
        self.assertIn("20200101", desc)
        self.assertIn("20241231", desc)


if __name__ == "__main__":
    unittest.main()
