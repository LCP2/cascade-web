"""CAS-1055 — the age_rating publish boundary: a cache-era record still carrying TMDB's raw,
un-canonical spelling must never reach movies.json.

The defect: canon_age_rating (CAS-1048) only ever ran at TMDB fetch time (_tmdb_record). Any
record cached before CAS-1048 shipped kept its raw spelling ("MA15+"/"R18+") forever — the
TTL-gated revalidation schedule would not touch it again for months — and published straight into
movies.json. is_publishable_record is the one guard every publication path (enrich_candidates_for_
publication, select_publishable) already runs each candidate through, so it is also where this
canonicalises: see CAS-1055's change there.

Run: python -m unittest tests.test_cas1055_age_rating_publish_boundary
"""
import unittest

import poc_pipeline as pp


def _publishable_record(tmdb_id=1, age_rating="MA15+"):
    """A record shaped exactly like a pre-CAS-1048 cache entry: already fully enriched (so
    is_publishable_record's stub/date checks pass on their own), just carrying the raw TMDB
    certification spelling canon_age_rating was never run against."""
    return {"tmdb_id": tmdb_id, "title": f"T{tmdb_id}", "year": "2018",
            "cinema_date": "2018-04-25", "genres": ["Action"], "release_dates": [],
            "status": ["included_streaming"], "offers": [{"service": "Netflix", "type": "sub"}],
            "age_rating": age_rating}


class IsPublishableRecordCanonicalisesAgeRating(unittest.TestCase):
    def test_a_raw_spelling_is_rewritten_to_canonical_in_place(self):
        record = _publishable_record(age_rating="MA15+")
        self.assertTrue(pp.is_publishable_record(record))
        self.assertEqual(record["age_rating"], "MA 15+")

    def test_the_other_raw_spelling_is_rewritten_too(self):
        record = _publishable_record(age_rating="R18+")
        self.assertTrue(pp.is_publishable_record(record))
        self.assertEqual(record["age_rating"], "R 18+")

    def test_an_already_canonical_rating_is_left_untouched(self):
        record = _publishable_record(age_rating="M")
        self.assertTrue(pp.is_publishable_record(record))
        self.assertEqual(record["age_rating"], "M")

    def test_a_record_with_no_age_rating_is_untouched(self):
        record = _publishable_record()
        del record["age_rating"]
        self.assertTrue(pp.is_publishable_record(record))
        self.assertNotIn("age_rating", record)


class SelectPublishablePublishesTheCanonicalSpelling(unittest.TestCase):
    def test_a_cached_record_with_a_raw_spelling_publishes_canonical(self):
        candidates = {"1": _publishable_record(tmdb_id=1, age_rating="MA15+")}
        published, stats = pp.select_publishable(candidates, engine_scoreable_ids={1},
                                                 previously_published_ids=set(), held_ids=set(),
                                                 catalogue_target=10)
        self.assertEqual(stats["published"], 1)
        self.assertEqual(published[0]["age_rating"], "MA 15+")


if __name__ == "__main__":
    unittest.main()
