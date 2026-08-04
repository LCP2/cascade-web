# CAS-335 — Full-catalogue ingestion appraisal

Research spike, no code changes. Snapshot analysed: `movies.json` generated 2026-08-03 (1,968 titles), plus
every daily commit to `movies.json` from 2026-07-16 (repo's first commit) to 2026-08-03 (used to reconstruct
the catalogue's growth curve), `poc_pipeline.py` (current HEAD), and the CAS-127/CAS-128 commits that changed
ingestion scope. No live TMDB/OMDb/Watchmode calls were made — this is an offline session and the API keys
live only in GitHub Actions secrets (per `CLAUDE.md`), never the repo or a local shell. Where a finding would
normally need a live query, that's flagged explicitly rather than guessed.

## 1. Current size + bound

**Current count:** 1,968 titles (`movies.json`, `generated: "2026-08-03"`).

**The historical ~300 cap is already gone** — this happened over two weeks ago, not something this ticket
needs to fix:

- `poc_pipeline.py:39` — `# CAS-128: the ~300 cap is lifted now that availability is free (TMDB Providers, CAS-127).`
- `poc_pipeline.py:43` — `MAX_TITLES = int(os.getenv("MAX_TITLES", "5000"))` (was a hard `60` before CAS-128;
  `CATALOGUE_TARGET` — the persisted catalogue size — defaults to `MAX_TITLES`, `poc_pipeline.py:79`).
- `poc_pipeline.py:227` — page depth for the TMDB `discover` loop now scales with the cap (`ceil(cap/20)`,
  bounded by TMDB's own 500-page discover limit), replacing a hard ~10-page/~200-title loop.
- Landed in commit `170406d`, **2026-07-22** ("CAS-128: lift the ~300 catalogue cap — full AU 3-year set,
  config-driven").

**Today's nominal ceiling is 5,000** (`MAX_TITLES` = `CATALOGUE_TARGET`), and the catalogue sits at 1,968/5,000
(39.4% of that ceiling) — but the ceiling is not what's limiting growth. `movies.json`'s commit history shows why:

| Commit | Date | Count |
|---|---|---|
| `dbdf260` (initial commit, sample/test data) | 2026-07-16 | 72 |
| `1212eff` (first run after CAS-128 shipped) | 2026-07-22 | **1,950** |
| `62c1bcc` | 2026-07-22 (later) | 1,952 |
| `79af995` | 2026-07-23 | 1,954 |
| `0471880` | 2026-07-24 | 1,955 |
| `c50b4b8` | 2026-08-03 | 1,968 |

The **very first run** after the cap lifted jumped straight to 1,950 — not a gradual climb toward 5,000. In
the 12 days since, it has grown by only 18 titles (~1.5/day). This is the signature of a query that already
exhausted its own supply in one pass (`_discover_au_theatrical`'s page loop breaks the moment TMDB returns an
empty page, `poc_pipeline.py:236-237` — it never got near the 250-page allowance that a 5,000 cap implies),
not a cap holding growth back. **The real constraint today is §2, not the cap.**

## 2. Coverage vs target

**The catalogue's true boundary is a scope filter, not a count.** `_discover_au_theatrical`
(`poc_pipeline.py:218-251`) queries TMDB `discover/movie` with `with_release_type=2|3` — TMDB's codes for AU
**theatrical (3) or limited theatrical (2)** release only. Release types 1 (premiere), 4 (digital), 5
(physical), and 6 (TV) are excluded categorically, at every layer, regardless of `MAX_TITLES`/
`CATALOGUE_TARGET`. Raising either constant further would buy nothing: the ~1,968 already appears to be
close to 100% of what TMDB tracks as an AU theatrical/limited release in the trailing 3-year (`LOOKBACK_DAYS`
= 1095) window — confirmed by the growth-curve evidence in §1, not by a live count (see caveat below).

That means the addressable universe this pipeline was built to cover (films with an AU cinema history) looks
**already well covered**. But "watchable in AU" is a bigger universe than "had an AU cinema release" — every
streaming-exclusive original (a film that launches straight to a subscription service, never in a cinema) is
invisible to this pipeline by design, at any catalogue size. The code already anticipated this as a distinct
future phase, not an oversight:

- `poc_pipeline.py:40-41` — *"All three are env-driven so widening — including the Phase-3 'drop the
  cinema-release requirement → all films' — is a one-line config change, no code edit."*

That comment undersells the actual cost (see §4) — dropping `with_release_type` isn't a one-line config
change once you look at what TMDB's API can and can't answer — but it confirms this gap was a known,
deliberately deferred decision (labelled "Phase 3"), not new information from this appraisal.

**Caveat — no live coverage number or named gap examples in this appraisal.** The ticket asks for an estimate
of the addressable AU universe and concrete missing-title examples. Producing either credibly needs a live
TMDB/JustWatch/Watchmode query (e.g. a `discover` call with `with_release_type` unset or narrowed to `=4`, or
a provider-catalogue listing for a specific AU service) to see what's out there that this pipeline's
theatrical-only filter would never surface. No API keys are available in this offline session, so this
appraisal can name the *mechanism* of the gap (the release-type filter) precisely, with exact code
citations, but not its *size* or specific missing titles. That live query is the cheap first step of any
follow-up (§5).

## 3. Pipeline shape

Entry point `poc_pipeline.py` (`python poc_pipeline.py --build-html` per `pipeline.config.json`). Stages
(docstring, `poc_pipeline.py:6-9`): `ingest (TMDB) → enrich (OMDb) → availability (TMDB Watch Providers, AU)
→ derive status → diff vs yesterday → emit alerts`.

- **Ingest** — `_discover_au_theatrical` (`poc_pipeline.py:218-251`): paginated TMDB `discover/movie`
  (~20 results/page, AU theatrical/limited only, most-popular first), one detail call per new title
  (`append_to_response=release_dates,videos,credits`), paced `TMDB_PACING=0.05s` between detail calls. Two
  passes share one `seen` set for dedupe: `ingest_tmdb()` (backward, `LOOKBACK_DAYS`=1095, cap `MAX_TITLES`)
  and `ingest_tmdb_upcoming()` (forward, `UPCOMING_LOOKAHEAD_DAYS`=540, cap `MAX_UPCOMING`=100).
- **Merge** (`build_live_catalogue`, `poc_pipeline.py:533-553`) — loads yesterday's snapshot as `base`, only
  calls the ingest passes at all when `len(base) < CATALOGUE_TARGET` (line 549), merges new titles not
  already in `base`, sorts by popularity, truncates to `CATALOGUE_TARGET`. Since the catalogue is already
  near-saturated within its scope (§2), most days' ingest calls now add close to nothing — this stage is
  effectively idle most runs, not the pipeline's cost centre.
- **Availability (primary, daily)** — `tmdb_providers()` (`poc_pipeline.py:340-355`): one TMDB Watch
  Providers call per released title, every day, across the whole catalogue (~1,968 calls/day today). Free
  and unquota'd (comment, `poc_pipeline.py:84-86`: "TMDB historically allows ~50 req/s and no daily cap"),
  paced at `TMDB_PACING` (~20/s) — a *time* cost (~100s of sleep alone at current size), not a *budget* cost.
  This is the pipeline's real N+1-per-title step, and it scales linearly with catalogue size, but headroom
  here is effectively unlimited at AU-theatrical scale.
- **Enrichment (bounded, budgeted)** — OMDb (`enrich_omdb`, `poc_pipeline.py:279-300`): ratings/RT/Metacritic
  /awards, `OMDB_DAILY_BUDGET=800` new + `OMDB_REFRESH_BUDGET=100` re-read against a believed
  `OMDB_FREE_TIER_CAP=1000`/day (already breached once pre-tuning — see §4). Watchmode
  (`poll_watchmode`, `poc_pipeline.py:395-425`) is **on-demand only** since CAS-127 (titles a user
  opened/saved, `ONDEMAND_WM_CAP` defaulting to 15/day) — this was the original per-title bottleneck and
  CAS-127 deliberately broke the coupling between catalogue size and Watchmode cost.
- **Rate-limiting** — `get_json()` (`poc_pipeline.py:108-120`) retries 429/5xx up to 4 times, honouring
  `Retry-After` or exponential backoff (cap 30s); a per-API circuit breaker (`_api_call`) trips on a
  cap/key-rejection signal so a bad key degrades one run gracefully instead of hammering it (fail counts
  surfaced in the run summary).
- **Diff/alerts** — `diff_and_alert()` (`poc_pipeline.py:475`) compares today's status set per title against
  `state/last_snapshot.json`; out of scope for this ticket (covered by the CAS-334 appraisal, which found the
  alert path has no debounce against backward transitions — unrelated to catalogue size).

**Bottleneck for today's scope:** none, practically — ingest is idle most days, TMDB providers are
unquota'd, and OMDb/Watchmode are already the tightest resources (see §4), independent of catalogue size.

## 4. Cost / feasibility of removing the cap

**There is no cap left to remove within the current scope** — `MAX_TITLES`/`CATALOGUE_TARGET` (5,000) already
sit at 2.5x the actual AU theatrical/limited supply (~1,968), and TMDB Watch Providers (the daily cost driver)
is free and unquota'd, so raising those constants further today would cost nothing and change nothing (§1–§3).

**Widening scope (the "Phase 3" comment) is a different, real cost, not a config tweak:**

- TMDB's `discover/movie` has no query that means "any AU release of any type" — dropping
  `with_release_type` entirely returns TMDB's whole catalogue (every film TMDB has ever indexed, most with no
  AU relevance at all), which is unusable as-is; narrowing it to `=4` (digital-only) would need its own
  page-budget and detail-call pass, roughly doubling the ingest-side API volume for a still-uncertain yield
  (§2 caveat — the actual gap size isn't known yet).
- TMDB alone doesn't have a "what's on Netflix/Prime/etc in AU right now" catalogue-style endpoint — it only
  answers "what are this title's AU providers" per-title (the existing `tmdb_providers()` call), which
  requires already knowing the title. Genuinely surfacing streaming-exclusive titles this pipeline has never
  seen would most plausibly need a provider-side catalogue listing (Watchmode or JustWatch both offer this,
  at real per-call cost), not another TMDB discover pass.
- Watchmode is the one integration already metered (2,500 calls/month, rationed to 15/day on-demand,
  CAS-127) — any Phase-3 design that leans on it for bulk catalogue discovery (rather than per-title
  enrichment) would need a materially larger/paid tier, a genuinely new cost line, not a constant bump.
- OMDb is already near its practical ceiling: `poc_pipeline.py:89-93` (CAS-161) documents the 2026-07-24
  incident where the OMDb+Watchmode combined daily spend (900+150=1,050) exceeded the believed 1,000/day free
  cap and produced a live 401 the same day a second run happened — since tightened to 800+100=900 for ~10%
  headroom. A materially larger catalogue would need a bigger OMDb allowance (paid tier) well before it needs
  a bigger TMDB allowance, since OMDb enrichment (unlike TMDB providers) scales with every *new* title, not
  just released ones.
- `.github/workflows/daily.yml` runs once/day, no explicit timeout (GitHub's 360-min job default), with
  `concurrency.cancel-in-progress: false` guarding against overlapping runs (the direct fix for the
  2026-07-24 double-run incident above). No evidence in the workflow or code that current run time is close
  to any real ceiling — build-time/storage cost of the *current* scope is not a constraint.

**Net: raising the number is free; widening the definition of what's ingested is the one part of "remove the
cap" that has a real cost, and that cost is dominated by which new data source pays for streaming-exclusive
discovery (Watchmode/JustWatch catalogue listing, not TMDB), not by compute or storage.**

## 5. Recommended follow-up build tickets (ranked by impact)

1. **This is a scope/product decision, not an engineering one — get that decision before scoping a build
   ticket.** Does Cascade track "films with an AU cinema history moving through the cascade" (current,
   consistent with the whole in-cinema → premium → rental → streaming product metaphor), or "everything
   watchable in AU" (would add streaming-exclusive originals, which have no cascade to track — they're just
   always on one service from day one)? The two answers lead to different build tickets; recommend Lee
   decide first.
2. **If widening is wanted: start with a single live measurement call**, not a build. One live TMDB `discover`
   query with `with_release_type` unset or `=4` (digital-only) against the same 3-year AU window would give
   an actual gap-size number and a first batch of concrete missing titles — cheap (a handful of API calls),
   and turns §2's caveat into real numbers before committing to a new ingestion path. This appraisal could
   not run that call this session (no local API keys, by design per `CLAUDE.md`).
3. **If staying theatrical-scoped (status quo): no build ticket needed for catalogue size.** The ~300 cap is
   already gone (CAS-128, 2026-07-22) and the current 5,000 ceiling has 2.5x headroom over actual AU
   theatrical/limited supply. If CAS-126 is the parent ticket that asked for "remove the cap," it can close
   on the strength of CAS-127/128 already having done that — this appraisal found nothing left to build there.
   Redirect any spare capacity to CAS-334's findings instead (e.g. its #1: suppressing backward-status alert
   noise), which affect data users already see, unlike catalogue breadth which is already saturated within
   scope.

Relates CAS-126, CAS-109, CAS-127, CAS-128, CAS-334.
