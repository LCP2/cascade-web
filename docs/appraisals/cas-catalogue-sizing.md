# Catalogue sizing — TMDB discover total_results (CAS-354, CAS-522)

Measured 2026-08-21 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-08-22..2026-08-21, sort_by=popularity.desc)

- total_results: 1884
- total_pages: 95

## Widened scope, unbounded (everything watchable in AU across all of film history: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction, no date bound)

- total_results: 90957
- total_pages: 4548

## Widened scope, 3yr-bounded (same AU-watchable query as above, but bounded to the same 2023-08-22..2026-08-21 window as current-scope — extra non-cinema-release titles within the 3 years we already cover)

- total_results: 16648
- total_pages: 833

## Quality-gated pool (AU-watchable, watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, sort_by=popularity.desc — CAS-548)

| # | Window | vote_average.gte | vote_count.gte | total_results | total_pages |
| --- | --- | --- | --- | --- | --- |
| 1 | in-window (2023-08-22..2026-08-21) | 5.9 | 0 | 8800 | 440 |
| 2 | in-window (2023-08-22..2026-08-21) | 5.9 | 50 | 4761 | 239 |
| 3 | in-window (2023-08-22..2026-08-21) | 5.9 | 250 | 3184 | 160 |
| 4 | pre-window (release_date.lte=2023-08-21, no lower bound) | 5.9 | 50 | 14514 | 726 |

