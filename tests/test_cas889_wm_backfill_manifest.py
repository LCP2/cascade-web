"""CAS-889 - state/wm_backfill_manifest.txt, the hand-placed list of tmdb_ids Lee's agents
actually track.

This is committed data, not a script's output (CAS-889 withdrew the stratified-sample generator
in favour of a one-off browser capture) - the realistic failure is a truncated or otherwise
corrupted commit, which is exactly what this checksum test catches.
"""
import os
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST_PATH = os.path.join(_REPO_ROOT, "state", "wm_backfill_manifest.txt")

EXPECTED_COUNT = 426
EXPECTED_SUM = 474593865


def _read_ids(path):
    ids = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            ids.append(int(line))
    return ids


class WmBackfillManifestTestCase(unittest.TestCase):
    def test_manifest_parses_to_426_unique_ids_summing_to_the_verified_checksum(self):
        ids = _read_ids(MANIFEST_PATH)
        self.assertEqual(len(ids), EXPECTED_COUNT)
        self.assertEqual(len(set(ids)), EXPECTED_COUNT)
        self.assertEqual(sum(ids), EXPECTED_SUM)


if __name__ == "__main__":
    unittest.main()
