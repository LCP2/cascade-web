# CC Autonomy Contract — Cascade (PoC stream)

> Kickoff prompt: **"Follow CC_AUTONOMY_CASCADE.md."** Everything below governs your run.
> Filename is stream-specific on purpose: this file drives the **Cascade PoC** stream only. Do not run it from any other project's clone.
> **This stream owns the PoC only** — repo `LCP2/cascade-movies` (the live static-site prototype). The native app repo `LCP2/cascade` is a **separate future stream** (its own `CC_AUTONOMY_CASCADE_APP.md`) — do not touch it.

## Design standard — READ FIRST, applies to every ticket
Before claiming or working any ticket, read the design/UX references in the Confluence **Cascade** space:
- **UX Psychology — Principles & Cascade Applications** — smart defaults, goal-gradient, reciprocity, endowment, loss aversion, contrast/anchoring, and the **honesty guardrail**.
- **Cascades — Living Searches (Product Concept)** — the Cascade model, templates, tagging modes, per-status alert prefs.
- **PoC — Design-Validation Plan** — the P1–P5 briefs these tickets are drawn from.

Every change must comply. **Honesty guardrail:** any urgency / savings / countdown copy must be truthful — no fabricated timers, no fake scarcity, no fake progress. If a ticket conflicts with these references, flag it in a ticket comment instead of shipping.

## Variables
- **Tracker project key:** `CAS` (Jira — codynamics.atlassian.net)
- **Repo:** `LCP2/cascade-movies` (live PoC — static site on GitHub Pages)
- **Live URL:** https://lcp2.github.io/cascade-movies/
- **Local clone path:** `C:\dev\cascade-movies` (repos live under `C:\dev\<repo>`) — if not cloned yet: `git clone https://github.com/LCP2/cascade-movies.git C:\dev\cascade-movies`.
- **Stack / build:** Python 3. `poc_pipeline.py` renders the app by injecting the movie data + date into the template **`app_template.html`** → `index.html` (function `build_html()`; placeholders `__MOVIES_JSON__`, `__TODAY__`). No `requirements.txt`; `--build-html` uses only the standard library.
- **Where front-end/UX changes go:** edit **`app_template.html`** (the source of the UI), NOT the generated `index.html` directly. Then rebuild `index.html` from it (below) and commit BOTH files. Prototype-only state (e.g. "My Cascades") may use `localStorage`.
- **Build / Verify command:** `python poc_pipeline.py --build-html` — rebuilds `index.html` from `app_template.html` + the committed `movies.json`, **no API keys needed**. Trust its exit code; then open `index.html` to confirm it renders. (For data-pipeline tickets, a full `python poc_pipeline.py` runs against bundled `sample_data.json` when the `TMDB_API_KEY` / `OMDB_API_KEY` / `WATCHMODE_API_KEY` env vars are absent, or live when they're set — the daily GitHub Action already holds the live keys as secrets.)
- **Deploy:** GitHub Pages serves `index.html` from `main`/root. **Committing the rebuilt `index.html` (+ `app_template.html`) to `main` updates the live site within ~1 min — that IS the deploy.** The `daily.yml` workflow only refreshes DATA on a cron/manual dispatch; you do NOT need to touch it or add a push trigger for front-end work.

## Claim
On every start, query Jira:

    project = CAS AND labels = needs-cc AND statusCategory != Done
    ORDER BY priority DESC, key ASC

Pick the **TOP** ticket. Claim it by adding the label `cc-active`.
If the query returns nothing: report **"queue empty, nothing to claim"** and **STOP**.
Do NOT work tickets that lack `needs-cc` — those are the native-app backlog, not this stream.

## Work
Read the ticket description and the linked Confluence docs. Create a branch. Implement the change per the **Acceptance criteria** and the design standard above. Keep all changes scoped to `LCP2/cascade-movies`. Front-end/UX changes go in `app_template.html`.

## Verify
Run the build/verify command. **NEVER infer success** — only trust the command's exit code / the site actually loading. If it fails, fix and re-run. Do not ship red.

## Ship
On green: rebuild `index.html` (`--build-html`), commit `app_template.html` + `index.html` (+ any data/state files a pipeline ticket changed), and merge to `main` (Pages redeploys the live site). Then set the ticket's label to `needs-lee`, remove `cc-active`, and post the **live link** + a one-line "what changed / what to look at" in a ticket comment. Return to **Claim** and take the next ticket.
Note: **visual / UX correctness is Lee's call** — flag `needs-lee` and describe what to review; do not self-certify the look.

## Guardrails
- **Stay in your lane:** this stream owns `LCP2/cascade-movies` and works ONLY tickets labelled `needs-cc`. Never touch the native app repo `LCP2/cascade` (that's a separate stream, `CC_AUTONOMY_CASCADE_APP.md`).
- **One ticket at a time.** Claim-lock with `cc-active` before starting.
- **Honesty guardrail:** truthful urgency/savings copy only — no fabricated timers or scarcity.
- **Don't deep-fake backend features** in the PoC (real push / accounts / sync). Validate concept + copy only; `localStorage` prototype state is fine.
- A stale `cc-active` from a crashed run is safe to reclaim.
- **Queue empty → report and stop.** Don't invent work.
