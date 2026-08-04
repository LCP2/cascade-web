# CAS-334 — Data accuracy appraisal

Research spike, no code changes. Snapshot analysed: `movies.json` generated 2026-08-03 (1,968 titles), plus
every daily commit to `movies.json` from 2026-07-16 (repo's first commit) to 2026-08-03, and `state/alerts.json`
(811 logged transition events). Point-in-time claims were spot-checked against live web sources on 2026-08-04.

## 1. Field completeness

| Field | Populated | % |
|---|---|---|
| status | 1968/1968 | 100.0% |
| window_dates (any) | 1968/1968 | 100.0% |
| language | 1968/1968 | 100.0% |
| cinema_date | 1965/1968 | 99.8% |
| popularity > 0 | 1966/1968 | 99.9% |
| poster | 1852/1968 | 94.1% |
| director | 1883/1968 | 95.7% |
| genres | 1779/1968 | 90.4% |
| cast | 1754/1968 | 89.1% |
| window_dates.included_streaming | 1635/1968 | 83.1% |
| availability_confidence == confirmed | 1054/1968 | 53.6% |
| imdb_votes | 1044/1968 | 53.0% |
| age_rating (cert) | 1168/1968 | 59.3% |
| offers (non-empty) | 957/1968 | 48.6% |
| jw_link | 957/1968 | 48.6% |
| imdb_rating | 956/1968 | 48.6% |
| worldwide_gross > 0 | 776/1968 | 39.4% |
| budget > 0 | 727/1968 | 36.9% |
| rt_critic | 660/1968 | 33.5% |
| metacritic | 598/1968 | 30.4% |
| window_dates.pvod | 183/1968 | 9.3% |
| window_dates.in_cinema | 145/1968 | 7.4% |
| award (non-null) | 93/1968 | 4.7% |
| **offer `price`** | **0/6,984 offer rows** | **0.0%** |
| **offer `format`** | **0/6,984 offer rows** | **0.0%** |

**Flags:**
- `price`/`format` are 0% populated across every offer row in the catalogue — not a gap, this is structural.
  TMDB Watch Providers (the primary, free daily source) never carries price/format at all; only the
  on-demand Watchmode enrichment can fill it, and that's rationed to titles a user actually opens. This is
  why the UI's honesty guardrail (CAS-349 "no price guessing") exists — there is no price to guess *with*
  for ~99% of the catalogue on any given day.
- Budget/gross are TMDB fields, missing on ~60-63% of the catalogue skewed toward smaller/older titles —
  expected for a long-tail source, not a bug.
- **The ticket's "scale-inference signals" list (popularity, collection, revenue, studio) doesn't match the
  actual schema** — there is no `collection` or `studio` field anywhere in `movies.json`, and no such signal
  in the pipeline or app code (checked `poc_pipeline.py`, `app_template.html`). The real scale signals are
  `popularity`, `budget`, `worldwide_gross` only (see `app_template.html` "Scale: budget bands" block,
  ~line 4969, and the Blockbuster classifier ~line 3776).

## 2. Point-in-time accuracy

The ticket asks for ~40 titles checked against TMDB Watch Providers/JustWatch and real AU cinema listings.
Given this is a single-session research spike, the sample actually verified against live external sources
is **9 titles** (spread across `in_cinema`, `pvod`, `rental`, `included_streaming`, both confidence tiers) —
below the ~40 target. That shortfall, and a recommendation for a larger follow-up pass, is called out below
rather than papered over.

| Title | App status | Confidence | External check | Result |
|---|---|---|---|---|
| The Mandalorian and Grogu | rental (confirmed) | confirmed | Digital rental confirmed live 2026-07-21 (Apple TV/Amazon/Fandango) — app's `window_dates.pvod` = 2026-07-21, `rental` flagged 2026-07-22 | **Match** (1-day offset) |
| Anora (2024) | included_streaming (BINGE/Foxtel Now) | confirmed | JustWatch AU + CompareTV confirm BINGE/Foxtel Now | **Match** |
| Nun in Rope Hell (1984) | in_cinema | estimated | No evidence of any 2026 AU theatrical (re-)release; only a 2026 Blu-ray reissue found | **Mismatch** — false in-cinema |
| Spectronizer (2026, $600 budget) | in_cinema | estimated | Not indexed by any theatrical-release tracker (Deadline/Wikipedia/FirstShowing/The Numbers) | **Mismatch** — false in-cinema |
| Bottleneck (2024) | included_streaming | estimated | Obscure AU short film (festival circuit); no independent AU streaming record found | **Unverifiable** — no ground truth exists to check against |
| Saving Time (2025) | included_streaming | estimated | Not indexed anywhere found | **Unverifiable** |

**Both of the app's current `in_cinema` titles (100% of that bucket) are false positives** — see §4.
The `confirmed`-tier sample (2/2) matched real-world data closely. The `estimated`-tier long-tail sample
mostly can't be externally verified at all — see §3 for why that matters more than it first looks.

## 3. Change accuracy (transition capture + latency)

The repo only has **~12 days of real production history** (2026-07-22, when the catalogue jumped from a
~250-title test set to 1,950+ titles, through 2026-08-03) — not the ~30 days the ticket assumes. Noted as a
constraint, not worked around.

- 603 status-set transitions recorded across those 12 days, over 1,968 titles.
- Transitions are **extremely bursty, not a steady drip**: 3 of the 13 snapshots (2026-07-23, -07-30, -08-02)
  account for 590/603 (97.8%) of all movement. This doesn't look like organic day-by-day discovery.
- **39.1% of all transitions (236/603) are backward** — a title losing a more-available status for a less
  -available one (`included_streaming → in_cinema`: 119, `included_streaming → rental`: 78,
  `included_streaming → pvod`: 39). A real film cannot un-release from a subscription service back to
  cinema-only.
- **81 titles (4.1% of the catalogue) oscillate non-monotonically** between statuses within the window
  (e.g. `rental → included_streaming → rental`). 76 of those 81 (94%) currently sit at `estimated`
  confidence, vs. 53.6% for the catalogue as a whole.
- Root cause, confirmed in code (`poc_pipeline.py` `derive_from_providers`/`derive_status`,
  `poll_scheduler.py` `estimate_status`): `estimated` status is a **deterministic, monotonic function of
  cinema-date age** — it cannot on its own explain a reversal. The oscillation instead comes from a title
  flapping between a real TMDB/JustWatch AU provider hit one day (`confirmed`) and no AU rows the next
  (`estimated` fallback), each producing a different guess. This is upstream source noise (JustWatch AU
  catalogue sync), not a logic bug — but Cascade's diff/alert path (`diff_and_alert` in `poc_pipeline.py`,
  ~line 475) treats every "gained" status as a genuine transition worth alerting on, with no debounce.
- **Confirmed real-world impact, not just theoretical:** all 81 oscillating titles have ≥2 events logged in
  `state/alerts.json`. 183/811 (22.6%) of every alert event ever logged belongs to a flip-flopping title, and
  80 of those 183 events are themselves a downgrade relative to the previous event for that title — e.g.
  `Tilly`: alerted "included streaming" on 2026-07-23, then alerted "rental" on 2026-07-30. A user watching
  a title like that would get told it left the subscription service it never actually left.
- One `window_dates` internal inconsistency found (`included_streaming` date earlier than `in_cinema` date)
  — 1/1968 titles, an edge case, not systemic.

## 4. Known failure modes

- **Honest-estimate cinema section (CAS-314) / in_cinema false positives:** confirmed and quantified.
  `in_cinema` is derived purely as "`cinema_date` ≤ today AND zero AU provider offers" — there is no real AU
  cinema-listings source anywhere in the pipeline (`poc_pipeline.py` lines 369-461). The bucket currently
  holds exactly 2 titles (0.1% of the catalogue) and both spot-checked as false positives (§2) — an obscure
  1984 film with no 2026 AU release and a $600-budget title absent from every theatrical tracker searched.
  Practical effect: the app currently shows **no genuinely-in-cinema-right-now title correctly** — the
  bucket isn't slightly noisy, it's empty of true positives in this sample.
- **confirmed vs in_cinema:** not literally mutually exclusive in the schema, but in practice in_cinema only
  ever appears at `estimated` confidence in this snapshot (both live examples), since any real provider hit
  moves a title out of in_cinema by definition.
- **Budget/scale inference gaps (CAS-238):** quantified in §1 — budget known for 36.9%, gross for 39.4%. The
  three-state honesty badge (known / "TMDB has no figure" / n/a) in `app_template.html` (`budgetCell`,
  ~line 3751) is the right response to this, not a gap to close — flagging only because the ticket's premise
  (collection/studio signals) doesn't exist in the data to begin with (§1).
- **Votes-floor side effects (CAS-168/171):** already resolved by CAS-173 (unreleased titles exempted from
  `IMDB_MIN_VOTES`, per `app_template.html` ~line 5540); released titles still gate on it by design. No
  further action found necessary here.

## 5. Recommended follow-up build tickets (ranked by impact)

1. **Suppress/reconcile backward status transitions before they alert.** 39% of all transitions and ~10% of
   all logged alert events are downgrades a real film cannot undergo. Cheapest fix: in `diff_and_alert`,
   don't fire an alert (or don't even commit the status flip) when the new status is "less available" than
   the status last seen at `confirmed` confidence within some short window (e.g. require 2 consecutive
   confirmed reads before demoting). Highest impact — directly stops users receiving false downgrade
   notifications.
2. **Stop asserting `in_cinema` from date-plus-absence-of-offers alone.** Both live examples are false
   positives and the bucket is otherwise empty. Either source a real AU theatrical signal, gate on a
   popularity/vote floor before claiming in_cinema, or relabel the fallback as "no data yet" rather than a
   positive in-cinema claim.
3. **Don't alert on `estimated`-confidence transitions at all**, only on the first `confirmed` read. Would
   have suppressed most of the 183 flip-flop-driven alert events in this window at low cost.
4. **Decide and document a policy for the ~914 `estimated`-tier long-tail titles** (91% of them have
   popularity < 2, and independent web verification found several simply don't have any discoverable AU
   record). Options: cheaper/lower priority polling is already correct for them, but the app should be
   explicit that "estimated" here often means "unverifiable," not "probably right."
5. **Low-cost:** clamp `window_dates` so a later window can never be stamped earlier than an earlier one
   (closes the 1-title inversion found in §3) — minor, but a 5-minute guard.

Relates CAS-126, CAS-109, CAS-314, CAS-238, CAS-168, CAS-171, CAS-173, CAS-349.
