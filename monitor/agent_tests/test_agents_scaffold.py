"""Placeholder for CAS-789's agent-behaviour suite (python half).

Deliberately outside monitor/tests/ so `npm run qa` (python -m unittest discover -s
monitor/tests) never picks these specs up — see QA-AGENTS.md. Run on request via
`npm run test:agents`.
"""
import unittest


class Scaffold(unittest.TestCase):
    def test_placeholder(self):
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
