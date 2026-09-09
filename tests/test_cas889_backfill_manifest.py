"""CAS-889 - the stratified Watchmode backfill manifest (scripts/cas889_backfill_manifest.py).

Every test builds its own fixture catalogue in a temp dir; none of them touch the real
movies.json or state/wm_backfill_manifest.txt.
"""
import os
import sys
import tempfile
import unittest

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "scripts"))
import cas889_backfill_manifest as manifest  # noqa: E402

PINNED = manifest.PINNED_TMDB_IDS
D1_SAMPLE_SIZE = 5


def _movie(tmdb_id, imdb_rating=None, imdb_votes=None, popularity=None, fetched=False):
    m = {"tmdb_id": tmdb_id, "title": f"movie-{tmdb_id}"}
    if imdb_rating is not None:
        m["imdb_rating"] = imdb_rating
    if imdb_votes is not None:
        m["imdb_votes"] = imdb_votes
    if popularity is not None:
        m["popularity"] = popularity
    if fetched:
        m["wm_fields_fetched_at"] = "2026-09-01"
    return m


def _fixture_movies(d1_pool_size=10):
    movies = []
    # Pinned: one already fetched (must be excluded), the rest untouched.
    movies.append(_movie(PINNED[0], fetched=True))
    for pinned_id in PINNED[1:]:
        movies.append(_movie(pinned_id, popularity=0.1))

    # Stratum A: imdb_rating + >= 1,000 votes.
    for i in range(3):
        movies.append(_movie(2000 + i, imdb_rating=7.0, imdb_votes=5000))
    # One stratum-A candidate already fetched — must not appear anywhere.
    movies.append(_movie(2999, imdb_rating=7.0, imdb_votes=5000, fetched=True))

    # Stratum C: imdb_rating + < 1,000 votes.
    for i in range(4):
        movies.append(_movie(3000 + i, imdb_rating=6.0, imdb_votes=100))

    # Stratum D1 pool: no imdb_rating, popularity < 2.
    for i in range(d1_pool_size):
        movies.append(_movie(4000 + i, popularity=0.5))
    # Not D1 — popularity too high, and has no imdb_rating either; excluded from every group.
    movies.append(_movie(5000, popularity=50.0))

    return movies


class BuildManifestTestCase(unittest.TestCase):
    def test_pinned_ids_come_first_and_exclude_the_already_fetched_one(self):
        groups = manifest.build_manifest(_fixture_movies(), d1_sample_size=D1_SAMPLE_SIZE)
        pinned_ids = dict(groups)["pinned"]
        self.assertEqual(pinned_ids, PINNED[1:])

    def test_every_stratum_a_and_stratum_c_candidate_appears(self):
        groups = dict(manifest.build_manifest(_fixture_movies(), d1_sample_size=D1_SAMPLE_SIZE))
        stratum_a = next(v for k, v in groups.items() if k.startswith("stratum A"))
        stratum_c = next(v for k, v in groups.items() if k.startswith("stratum C"))
        self.assertEqual(set(stratum_a), {2000, 2001, 2002})
        self.assertEqual(set(stratum_c), {3000, 3001, 3002, 3003})

    def test_d1_block_has_exactly_the_requested_sample_size(self):
        groups = dict(manifest.build_manifest(_fixture_movies(d1_pool_size=10),
                                               d1_sample_size=D1_SAMPLE_SIZE))
        stratum_d1 = next(v for k, v in groups.items() if k.startswith("stratum D1"))
        self.assertEqual(len(stratum_d1), D1_SAMPLE_SIZE)
        self.assertTrue(all(4000 <= tmdb_id < 4010 for tmdb_id in stratum_d1))

    def test_no_already_fetched_id_appears_anywhere(self):
        groups = manifest.build_manifest(_fixture_movies(), d1_sample_size=D1_SAMPLE_SIZE)
        all_ids = [tmdb_id for _, ids in groups for tmdb_id in ids]
        self.assertNotIn(PINNED[0], all_ids)
        self.assertNotIn(2999, all_ids)

    def test_a_title_outside_every_stratum_is_excluded(self):
        groups = manifest.build_manifest(_fixture_movies(), d1_sample_size=D1_SAMPLE_SIZE)
        all_ids = [tmdb_id for _, ids in groups for tmdb_id in ids]
        self.assertNotIn(5000, all_ids)


class ManifestIsReproducibleTestCase(unittest.TestCase):
    def test_the_written_manifest_is_byte_identical_across_two_runs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            catalogue_path = os.path.join(tmpdir, "movies.json")
            import json
            with open(catalogue_path, "w", encoding="utf-8") as fh:
                json.dump({"movies": _fixture_movies(d1_pool_size=30)}, fh)

            out_a = os.path.join(tmpdir, "manifest_a.txt")
            out_b = os.path.join(tmpdir, "manifest_b.txt")
            manifest.run(catalogue_path=catalogue_path, out_path=out_a, d1_sample_size=D1_SAMPLE_SIZE)
            manifest.run(catalogue_path=catalogue_path, out_path=out_b, d1_sample_size=D1_SAMPLE_SIZE)

            with open(out_a, "rb") as fh:
                bytes_a = fh.read()
            with open(out_b, "rb") as fh:
                bytes_b = fh.read()
            self.assertEqual(bytes_a, bytes_b)
            self.assertGreater(len(bytes_a), 0)


if __name__ == "__main__":
    unittest.main()
