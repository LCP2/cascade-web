"""CAS-405: run tests/test_data_quality.py split into blocking and report-only checks.

Blocking checks (test_data_quality.BLOCKING_TESTS) are app-breakers: if one fails, this script
exits non-zero and fails the `data` job. Every other check in that file still runs on every push
(nothing is deleted) but is report-only — its result is printed, never fails this script. Run as
`python -m tests.run_data_quality` from the repo root, in place of a flat `unittest discover` over
test_data_quality.py.
"""
import sys
import unittest

from tests import test_data_quality as tdq


def _flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten(item)
        else:
            yield item


def _name(test):
    return f"{type(test).__name__}.{test._testMethodName}"


def main():
    all_tests = list(_flatten(unittest.TestLoader().loadTestsFromModule(tdq)))
    found = {_name(t) for t in all_tests}
    missing = tdq.BLOCKING_TESTS - found
    if missing:
        print(f"::error::blocking test(s) not found in test_data_quality.py: {sorted(missing)}")
        return 1

    report_only = unittest.TestSuite(t for t in all_tests if _name(t) not in tdq.BLOCKING_TESTS)
    blocking = unittest.TestSuite(t for t in all_tests if _name(t) in tdq.BLOCKING_TESTS)

    print(f"=== Report-only data-quality checks ({report_only.countTestCases()}) - "
          f"logged, never fail this job ===")
    report_result = unittest.TextTestRunner(verbosity=2).run(report_only)
    if not report_result.wasSuccessful():
        broken = len(report_result.failures) + len(report_result.errors)
        print(f"::warning::{broken} report-only data-quality check(s) failed - "
              f"catalogue drift, not blocking qa")

    print(f"\n=== Blocking data-quality checks ({blocking.countTestCases()}) - app-breakers only ===")
    blocking_result = unittest.TextTestRunner(verbosity=2).run(blocking)
    return 0 if blocking_result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
