# Catalogue sizing — TMDB discover total_results (CAS-354, CAS-522)

Measured 2026-08-18 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-08-19..2026-08-18, sort_by=popularity.desc)

- total_results: 1872
- total_pages: 94

## Widened scope, unbounded (everything watchable in AU across all of film history: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction, no date bound)

- total_results: 90973
- total_pages: 4549

## Widened scope, 3yr-bounded (same AU-watchable query as above, but bounded to the same 2023-08-19..2026-08-18 window as current-scope — extra non-cinema-release titles within the 3 years we already cover)

- total_results: 16630
- total_pages: 832

## Quality-gated pool (AU-watchable, watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, sort_by=popularity.desc — CAS-548)

| # | Window | vote_average.gte | vote_count.gte | total_results | total_pages |
| --- | --- | --- | --- | --- | --- |
| 1 | in-window (2023-08-19..2026-08-18) | 5.9 | 0 | 8795 | 440 |
| 2 | in-window (2023-08-19..2026-08-18) | 5.9 | 50 | 4748 | 238 |
| 3 | in-window (2023-08-19..2026-08-18) | 5.9 | 250 | 3177 | 159 |
| 4 | pre-window (release_date.lte=2023-08-18, no lower bound) | 5.9 | 50 | 14503 | 726 |

