# Cascade R5 — onboarding & selectivity redesign · CC build batch (staging only) · 2026-07-23

Hand this to local Claude Code (CC) as one run. It builds the signed-off onboarding/selectivity redesign to the **staging preview**, then leaves it for Lee's review + promote.

## Reference implementation — READ FIRST (both present in this repo)
- **`onboarding-mocks/r5-prototype.html`** — a complete, working click-through of the whole flow. This is the **authoritative spec** for layout, copy, states, interactions and styling. Open it, click through every screen, and match it. Its styles were extracted from the live staging app, so tokens already match production.
- **`onboarding-mocks/r5-buildspec.md`** — the locked decisions and per-agent defaults in prose.
- Jira epic **CAS-142**, children **CAS-143 … CAS-147**, all labelled `r5-redesign`.

## Global rules (do not break)
- Build to **`staging`** only. **NEVER `main`.** (CC contract `CC_AUTONOMY_CASCADE_WEB.md`.)
- ⛔ **Do NOT modify the production film card component (CAS-100).** This work is onboarding/selectivity chrome around the cards.
- Before starting, reconcile `staging` with `origin/main` so you build on the current catalogue.
- Guest / localStorage; **truthful copy** — wire counts to the real catalogue (the prototype's counts are synthetic placeholders).
- After each ticket: push to `staging`, confirm the Cloudflare preview (`cascade-web-3x1.pages.dev`) is green, comment the ticket with the commit SHA, flip `needs-cc-web` → `on-staging`.
- **Do NOT promote staging → production.** Lee reviews and promotes.

## Build queue
1. **CAS-146 — Taste baseline page** (build first; other screens read from it). Combined Genres / How-far-back / Language / Age on one page, one-at-a-time accordion. Age is a **range** (lowest→highest, gradient band, no dots). Account-level; inherited by every agent.
2. **CAS-145 — "Set your bar" rework.** Continuous People's-vote slider with live readout; **AND** logic; per-agent primary dials + "More controls"; **left-edge fill on every slider**; plain-English copy; plain (un-boxed) summary line. Buzz dial depends on CAS-147 — if the popularity data isn't wired yet, ship Buzz reading whatever popularity is available and flag it.
3. **CAS-144 — "Get selective" hub.** Two doors with per-door **completed state** (green ✓ + pulse) on return, advancing progress bar, **no skip**, and the **"Show me my N films →"** CTA once both are confirmed → completion screen.
4. **CAS-143 — "Pick your first agent".** Descriptive agent presets with per-agent defaults; counts in **violet**; step-progress rail.
5. **CAS-147 — Buzz signal (pipeline, supervised).** Surface TMDB `popularity` into `movies.json`; map to the four Buzz tiers; wire into the bar filter/rank. Can land in parallel / just after; the Buzz dial goes live once this is in.

## Model to preserve
Agent = (global **taste baseline**, inherited) + (per-agent **Channel × Standard**). Availability + baseline boundaries are hard filters; quality/scale/buzz rank & lean. AND across the dials a user turns up.

## Done criteria
All `r5-redesign` front-end tickets on `on-staging`, preview green, each commented with its commit; flow matches the prototype end-to-end. Leave the promote to Lee.

---
### Two decisions Lee should confirm at review (don't block the build)
1. **AND (not OR)** for the dials — reverses CAS-114. (Built as AND.)
2. **Age as a range** — a floor now excludes ratings below it (CAS-140). Confirm that's the intended family-filter behaviour.

### Relationship to the qa-r5 batch
This redesign supersedes the onboarding parts of qa-r5 — **CAS-138 / 139 / 140** are folded in here (see their comments). The rest of qa-r5 (performance CAS-129, listing/card fixes, animation) is unaffected and still stands.
