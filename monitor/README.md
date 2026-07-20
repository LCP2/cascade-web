# `monitor/` — daily monitoring diff

Build order 4 of 7 (CAS-84, spec 26771457 §5). This is the **change-detection** engine:
after `poc_pipeline.py` rebuilds today's `movies.json`, it compares today's catalogue with
**yesterday's** and reports the per-movie *transitions* — the moments a user's Cascade can
alert on.

The diff itself does no network I/O. The **matching** stage (CAS-85) reads the `cascades` and
`notifications` tables with the Supabase **service_role** key and — off `--dry-run` — writes the
notifications ledger. Sending the email arrives in CAS-86.

## Transitions (moments)

| Moment | Fires when |
| --- | --- |
| `hits_cinema` | the film's status newly gains `in_cinema` (theatrical window opened) |
| `hits_pvod` | status newly gains `pvod` (premium home video — a buy, or a rent above the rental price ceiling) |
| `hits_rent` | status newly gains `rental` (available to rent, ≤ the rental price ceiling) |
| `hits_stream` | status newly gains `included_streaming` (on an included/free service) |
| `past_opening_weekend` | today is exactly `cinema_date + N` days (N=4, tunable) — **computed from the film's real opening date**, not a catalogue diff |

**Honesty guardrail.** The four status moments only fire on a *genuine transition*: the film
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

## Matching + de-dupe (CAS-85)

For each **active** Cascade, a transition fires an alert when: its `moment` is in the Cascade's
`alert_moments`; the film matches the Cascade's taste `criteria` (genre / exclude / age / language
/ culture / awards / imdb / rt / budget / tentpole — the same rules as the front-end's
`matchesCriteria`, minus the window/status test the transition already establishes); for a
streaming moment, the arrival is on a service the Cascade named (`criteria.services`, when set);
and it isn't already in the `notifications` ledger. Hits are grouped per user for one digest each.

```bash
# full diff -> match -> de-dupe against fixtures (deterministic, no keys):
python -m monitor --dry-run \
  --today monitor/fixtures/today.json --yesterday monitor/fixtures/yesterday.json \
  --date 2026-07-16 --cascades monitor/fixtures/cascades.json \
  --notifications monitor/fixtures/notifications.json
```

With no `--cascades`, the Cascade + notifications source is Supabase via `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` (read from the environment — never hardcoded). `--dry-run` prints the
per-user hit list and writes nothing; without it, the matched rows are written to `notifications`.

> `criteria.services` is the per-Cascade service filter. The current front-end keeps the user's
> service list in device-local prefs, so it's usually absent — meaning streaming arrivals aren't
> service-filtered yet. Populate it (a later story) to switch that on; the matcher already honours it.

## Tests

```bash
python -m unittest discover -s monitor/tests
```

The fixtures (`monitor/fixtures/`) are a yesterday/today pair engineered so a run dated
`2026-07-16` exercises each of the four moments once, plus the first-sighting and
no-change negatives.

## Email digest (CAS-86)

Matched hits become **one consolidated email per user per run**, sent via **Resend**. Each item
names the film, its transition in the agent's voice (`Now on Stan`, `Dropped to rent — $6.99`,
`In cinemas now`, `Past its opening weekend`), which Cascade caught it, and a link back to the
site. Every line is built from real data only — no invented urgency (honesty guardrail).
`RESEND_API_KEY` is read from the environment; `--dry-run` prints the HTML and sends nothing.
`CASCADE_EMAIL_FROM` and `CASCADE_SITE_URL` override the sender and the link target.

## Daily automation (CAS-87)

`.github/workflows/daily.yml` runs once a day (and on demand via **Run workflow**):

1. `poc_pipeline.py` rebuilds today's `movies.json`;
2. the refreshed files are committed (so git history holds "yesterday" for the diff);
3. `python -m monitor` runs — diff → match → de-dupe → email.

Secrets come from **GitHub Actions secrets only** (never hardcoded). With `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` and `RESEND_API_KEY` present it does the real thing; when any is
absent (e.g. before you've added them) it runs `--dry-run`, so the workflow still passes.

**One-time test email (Lee):** add the three secrets in **Settings → Secrets and variables →
Actions**, then **Actions → “Daily AU movie refresh + Cascade monitor” → Run workflow**. With a
signed-in account holding an active Cascade and a real catalogue change in the window, you'll get
the digest. (No change on the day → no email; that's correct, not a failure.)

## Files

- `transitions.py` — pure diff logic (`compute_transitions`, `Transition`).
- `matching.py` — match transitions to Cascades + de-dupe (`match`, `matches_criteria`, `scale_tiers`).
- `emailer.py` — render the digest (`render_digest`, `moment_phrase`) + send via Resend (`send_via_resend`).
- `store.py` — Cascade/notification/email access: `InMemoryStore` (dry-run/tests) + `SupabaseStore` (service_role, dependency-free urllib).
- `catalogue.py` — load today's `movies.json` and yesterday's via `git show HEAD~1`.
- `__main__.py` — the `python -m monitor` CLI (`--dry-run`).
- `fixtures/` — deterministic catalogues + cascades + emails for the demo + tests.
- `tests/` — unit tests (transitions + matching + emailer).
