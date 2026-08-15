# Catalogue sizing — TMDB discover total_results (CAS-354, CAS-522)

Measured 2026-08-15 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-08-16..2026-08-15, sort_by=popularity.desc)

- total_results: 1876
- total_pages: 94

## Widened scope, unbounded (everything watchable in AU across all of film history: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction, no date bound)

- total_results: 90937
- total_pages: 4547

## Widened scope, 3yr-bounded (same AU-watchable query as above, but bounded to the same 2023-08-16..2026-08-15 window as current-scope — extra non-cinema-release titles within the 3 years we already cover)

- total_results: 16641
- total_pages: 833

