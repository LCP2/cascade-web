#!/usr/bin/env python3
"""CAS-889: build state/wm_backfill_manifest.txt, a deliberately stratified tmdb_id sample for
scripts/cas850_watchmode_backfill.py's `--ids-from` argument.

The default backfill walks movies.json in file order, which poc_pipeline.py sorts by TMDB
popularity descending — so a partial trial backfill spends its budget confirming the easy,
already-popular case and leaves the population the damping rule actually has to be judged
against (no imdb_rating, low TMDB popularity) almost untested. This script picks a deliberate
sample instead, in this order:

  1. Five pinned titles, always included, chosen as the specific cases the damping rule has
     to be judged against.
  2. Stratum A in full — every remaining title with an imdb_rating and >= 1,000 imdb_votes,
     for a like-for-like comparison against the established IMDb-based score.
  3. Stratum C in full — every remaining title with an imdb_rating but under 1,000 votes,
     where Cascade already knows the audience is thin.
  4. A reproducible random sample (random.Random(850)) of stratum D1 — no imdb_rating at all
     and TMDB popularity under 2 — sized by MANIFEST_D1_SAMPLE.

Any id already carrying `wm_fields_fetched_at` is excluded from every group. This script only
builds the manifest; nothing reads it, and nothing here changes poc_pipeline.py, app_template.html
or movies.json.
"""
import json
import os
import random

CATALOGUE = os.environ.get("CASCADE_CATALOGUE", "movies.json")
OUT = os.environ.get("CAS889_MANIFEST_OUT", os.path.join("state", "wm_backfill_manifest.txt"))
MANIFEST_D1_SAMPLE = int(os.environ.get("MANIFEST_D1_SAMPLE", "600"))
IMDB_MIN_VOTES = 1000
D1_POPULARITY_CEILING = 2
SAMPLE_SEED = 850

# The specific cases the damping rule has to be judged against: Assassin Within, Plan Bea,
# Gun Pilots, The Snare, 32 Frames: A 9/11 Mystery.
PINNED_TMDB_IDS = [1755665, 1725099, 1710392, 1443302, 1699424]


def load_catalogue(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("movies", data) if isinstance(data, dict) else data


def build_manifest(movies, d1_sample_size=MANIFEST_D1_SAMPLE, seed=SAMPLE_SEED):
    """-> [(group_label, [tmdb_id, ...]), ...] in manifest order. Every id already carrying
    wm_fields_fetched_at is excluded; each remaining id appears in exactly one group."""
    by_tmdb_id = {}
    for movie in movies:
        tmdb_id = movie.get("tmdb_id")
        if tmdb_id is not None:
            by_tmdb_id[tmdb_id] = movie

    def already_fetched(tmdb_id):
        movie = by_tmdb_id.get(tmdb_id)
        return bool(movie and movie.get("wm_fields_fetched_at"))

    pinned = [tmdb_id for tmdb_id in PINNED_TMDB_IDS if not already_fetched(tmdb_id)]
    pinned_set = set(pinned)

    stratum_a, stratum_c, d1_pool = [], [], []
    for movie in movies:
        tmdb_id = movie.get("tmdb_id")
        if tmdb_id is None or tmdb_id in pinned_set or already_fetched(tmdb_id):
            continue
        imdb_rating = movie.get("imdb_rating")
        if imdb_rating:
            if (movie.get("imdb_votes") or 0) >= IMDB_MIN_VOTES:
                stratum_a.append(tmdb_id)
            else:
                stratum_c.append(tmdb_id)
        elif (movie.get("popularity") or 0) < D1_POPULARITY_CEILING:
            d1_pool.append(tmdb_id)

    sample_size = min(d1_sample_size, len(d1_pool))
    stratum_d1 = random.Random(seed).sample(d1_pool, sample_size)

    return [
        ("pinned", pinned),
        (f"stratum A - imdb_rating and >= {IMDB_MIN_VOTES} imdb_votes", stratum_a),
        (f"stratum C - imdb_rating and < {IMDB_MIN_VOTES} imdb_votes", stratum_c),
        (f"stratum D1 sample - no imdb_rating, popularity < {D1_POPULARITY_CEILING}, "
         f"seed {seed}", stratum_d1),
    ]


def write_manifest(out_path, groups):
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        for label, ids in groups:
            fh.write(f"# {label} ({len(ids)})\n")
            for tmdb_id in ids:
                fh.write(f"{tmdb_id}\n")


def run(catalogue_path=None, out_path=None, d1_sample_size=None, seed=SAMPLE_SEED):
    catalogue_path = catalogue_path or CATALOGUE
    out_path = out_path or OUT
    d1_sample_size = MANIFEST_D1_SAMPLE if d1_sample_size is None else d1_sample_size

    movies = load_catalogue(catalogue_path)
    groups = build_manifest(movies, d1_sample_size=d1_sample_size, seed=seed)
    write_manifest(out_path, groups)

    total = 0
    for label, ids in groups:
        print(f"{label}: {len(ids)}")
        total += len(ids)
    print(f"total: {total}")
    return groups


if __name__ == "__main__":
    run()
