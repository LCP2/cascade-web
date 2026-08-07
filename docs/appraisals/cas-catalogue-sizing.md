# Catalogue sizing — TMDB discover total_results (CAS-354)

Measured 2026-08-07 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-08-08..2026-08-07, sort_by=popularity.desc)

- total_results: 1871
- total_pages: 94

## Widened scope (everything watchable in AU: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction)

- total_results: 90598
- total_pages: 4530

