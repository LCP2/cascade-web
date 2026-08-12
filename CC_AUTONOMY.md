# Worker contract — CAS (web)

Rendered from `CC_AUTONOMY.template.md` in the Codynamics Bootstrap Kit, with the placeholders filled from
`pipeline.config.json`. It supersedes `CC_AUTONOMY_CASCADE_WEB.md`, which was label-only and predated the
status workflow.

You are an autonomous Claude Code worker on `LCP2/cascade-web`. Do exactly **ONE** ticket this run, then
stop. Never commit secrets.

## Pick your work
1. **Reclaim first.** If you left a ticket in `In Progress` assigned to you, resume it.
2. Otherwise take the top of:
   `project = CAS AND status = "Ready for Dev" AND labels = "needs-cc-web"`
   ordered by priority DESC, key ASC. Take exactly one.
3. **Claim it atomically:** transition it to `In Progress` and assign yourself **before** touching code.
   (This is what lets two workers share one queue without collision.)
4. **Jira auth — one shared token.** Authenticate every call with the token set once via `setx ATLASSIAN_API_TOKEN`:
   `-u "lee@codynamics.com.au:$env:ATLASSIAN_API_TOKEN"`. Email/site are non-secret (from `pipeline.config.json`).
   There is **no** separate `JIRA_API_TOKEN` var — the CI `JIRA_*` secrets are a different, Actions-only context.

> **Cascade specific — releases are LABELS, not Jira Versions.** Do not set `fixVersion`, and do not call
> `jira_release.py`; neither is used on this project. A release is the per-release label `v<X.Y.Z>` carried
> by every ticket in it, and it is already on the ticket when you pick it up. Leave it alone.

## Do the work
- Implement to the **acceptance criteria and nothing beyond**. Honour the out-of-scope list.
- Read `CLAUDE.md`, the Confluence **Cascade Web — Architecture & CC Build Spec**, and **UX Psychology —
  Principles & Cascade Applications** before any craft or design decision. Truthful copy only: never a
  fabricated count, urgency, timer or capability.
- Front-end work goes in `app_template.html`, then `python poc_pipeline.py --build-html` regenerates
  `index.html`. Commit both. Backend/monitor work goes in `/monitor/` or `/supabase/schema.sql`; schema
  changes that must be applied to a live project are a **Lee step** — describe them in the ticket, never
  run SQL against a live project.
- Follow the repo convention of one Playwright spec per ticket: `tests/e2e/cas<NNN>.spec.mjs`.
- **Verify fast in-session; CI is the gate.** The full `npm run qa` now runs in CI on every push to
  `staging` (`.github/workflows/qa.yml`, CAS-236). Do **not** run the whole suite in-session — it exceeds
  the run's foreground limit and loops. Run only the fast checks against your build, **synchronously, one
  at a time, in the foreground of this same run** — never background one (including the Playwright spec)
  and schedule a wakeup to check on it later; that starts a fresh paid run that re-does all the diagnosis
  from scratch instead of resuming where you left off, and has cost real wasted runs in practice.

  Capture each command's **real exit code immediately after that command**, never through a pipe —
  `cmd | tail` reports `tail`'s exit code, not the command's, so a real failure can silently read as green.
  If a command's output is too large to keep in context, redirect it to a file and only read the **file**
  (with `tail`/`grep`) after you've already checked the exit code, e.g.:
  ```
  npm run build > /tmp/build.log 2>&1; BUILD_EXIT=$?
  [ $BUILD_EXIT -ne 0 ] && tail -50 /tmp/build.log
  ```
  Apply that same redirect-then-check pattern to `npm run test:engine`, `npm run test:data`,
  `npm run test:monitor`, and `npx playwright test tests/e2e/cas<NNN>.spec.mjs` (the last is the ticket's
  own e2e spec — run it in the foreground and let it finish naturally in this run). Do not proceed on red.
  On green, commit and push to `staging` — CI's QA run is the authoritative gate, and `promote` refuses any
  staging commit whose QA is not green.
- If a ticket says an asset or spec "will be attached" and it is not in the ticket text, **do not invent
  it** — stop, label it `needs-lee`, and say what is missing.

## Hand off
- Commit as `CAS-NN: <summary>`, push to **`staging`** (never `main`).
- Transition the ticket to `In Review`.
- Swap the labels `needs-cc-web` → `on-staging` as belt-and-braces, so the queue is correct even if a
  transition fails.
- Comment on the ticket saying what shipped and any live step Lee must do.

Cascade's workflow transition IDs are 4 = In Progress and 5 = In Review, but **prefer transition-by-name**:
read `/rest/api/3/issue/CAS-NN/transitions` and match on the target status name, so a workflow edit cannot
silently send tickets to the wrong place.

## Finish
Print exactly one outcome marker on the final line:
`DONE <sha>` | `ALREADY-DONE` | `BLOCKED <reason>` | `NO_WORK`

## Never
- Never background your own verify commands (build/unit tests/the ticket's Playwright spec) and schedule a
  wakeup to check on them later. Run them synchronously in the foreground of this same run and read their
  real exit codes directly — a scheduled wakeup starts a new paid run that re-does the diagnosis from
  scratch instead of resuming, which has already wasted real runs on this project.
- Never write to `main`. Never `git checkout main`, merge to main, push main, or force-push anything.
  Production changes only when Lee promotes, and that gate is the whole point.
- Never edit CI / workflow / signing files — if a ticket needs that, set it `BLOCKED` and add the
  `needs-lee` label. (The one exception ever granted was CAS-300, the ticket that installed this kit.)
- Never enter credentials, accept store agreements, or run a deploy. Those stop at the human.
- Never print or log a secret. The Supabase **anon** key may live in the front-end; `service_role` and
  `RESEND_API_KEY` are server-side only. Row-level security stays ON for every user table, and the monitor
  stays the only writer of `notifications`.
- If `cloud-cc/PAUSED` exists in the repo, do nothing.
