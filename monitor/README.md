# `monitor/` — daily monitoring diff

Build order 4 of 7 (CAS-84, spec 26771457 §5). This is the **change-detection** engine:
after `poc_pipeline.py` rebuilds today's `movies.json`, it compares today's catalogue with
**yesterday's** and reports the per-movie *transitions* — the moments a user's Cascade can
alert on.

It does **no network I/O and no writes**. Matching transitions to users' Cascades, de-duping,
and sending the email arrive in the later stories (CAS-85 / CAS-86).

## Transitions (moments)

| Moment | Fires when |
| --- | --- |
| `hits_cinema` | the film's status newly gains `in_cinema` (theatrical window opened) |
| `hits_rent` | status newly gains `rental` (available to rent, ≤ the rental price ceiling) |
| `hits_stream` | status newly gains `included_streaming` (on an included/free service) |
| `past_opening_weekend` | today is exactly `cinema_date + N` days (N=4, tunable) — **computed from the film's real opening date**, not a catalogue diff |

**Honesty guardrail.** The three status moments only fire on a *genuine transition*: the film
must have been in yesterday's catalogue and not already in that window, so a film's first
sighting never produces an alert. `past_opening_weekend` only fires on a real, parseable
`cinema_date` (ref CAS-68) — never on a missing or invented date.

The moment names line up 1:1 with the `alert_moments` a Cascade stores
(`supabase/schema.sql`) and the front-end mapping (`CascadeShape` in `app_template.html`).

## Run it

```bash
# Against the live catalogue (today = movies.json, yesterday = git show HEAD~1:movies.json):
python -m monitor --dry-run

# Against the bundled fixtures (deterministic — proves all four transitions):
python -m monitor --dry-run \
  --today monitor/fixtures/today.json \
  --yesterday monitor/fixtures/yesterday.json \
  --date 2026-07-16
```

Flags: `--date YYYY-MM-DD` overrides the run date (drives `past_opening_weekend`);
`--weekend-n N` tunes the opening-weekend window; `--today` / `--yesterday` point at explicit
catalogue files instead of the defaults.

## Tests

```bash
python -m unittest monitor.tests.test_transitions
```

The fixtures (`monitor/fixtures/`) are a yesterday/today pair engineered so a run dated
`2026-07-16` exercises each of the four moments once, plus the first-sighting and
no-change negatives.

## Files

- `transitions.py` — pure diff logic (`compute_transitions`, `Transition`).
- `catalogue.py` — load today's `movies.json` and yesterday's via `git show HEAD~1`.
- `__main__.py` — the `python -m monitor` CLI (`--dry-run`).
- `fixtures/` — deterministic yesterday/today catalogues for the demo + tests.
- `tests/` — unit tests.
