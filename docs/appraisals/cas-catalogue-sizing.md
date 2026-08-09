# Catalogue sizing — TMDB discover total_results (CAS-354)

Measured 2026-08-09 by `scripts/catalogue_sizing.py`, run in CI (`.github/workflows/daily.yml`) where the TMDB key exists.

## Current scope (pipeline-identical: with_release_type=2|3, region=AU, 2023-08-10..2026-08-09, sort_by=popularity.desc)

- total_results: 1872
- total_pages: 94

## Widened scope (everything watchable in AU: watch_region=AU, with_watch_monetization_types=flatrate|free|ads|rent|buy, no release_type restriction)

- total_results: 90773
- total_pages: 4539

