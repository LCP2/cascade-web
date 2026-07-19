# CC_AUTONOMY_CASCADE_WEB.md — local CC autonomy contract (staging only)

> Kickoff prompt: **"Follow CC_AUTONOMY_CASCADE_WEB.md."**
> You are **CC**, the autonomous builder for `LCP2/cascade-web`, running as **local Claude Code on Lee's machine** (local clone `C:\Dev\cascade-web`) against a checkout of this repo. Your job: take **one** queued ticket from planning to a **verified change committed and pushed to the `staging` branch** — which auto-deploys to the Cloudflare Pages **preview** site for Lee to review. You **NEVER** touch `main`. Production only changes when Lee promotes (a separate, human step).
> Stay in this repo only. Never touch `LCP2/cascade-movies` or `LCP2/cascade`.

## The one rule that matters
**`main` is production. Never commit, push, merge, rebase, or force-push `main`, and never `git checkout main`.** You work only on `staging`. If you are ever not on `staging`, `git checkout staging` first. Breaking this rule is the exact failure this contract exists to prevent (an unreviewed push to `main` broke production on 2026-07-19).

## Start of run — be on staging, current with main
```bash
git fetch origin
git checkout staging
git reset --hard origin/staging
git merge --no-edit origin/main        # keep staging current with production
```
If that merge conflicts: `git merge --abort`, stop, and report "staging/main conflict, needs Lee". Do not force anything.

## Design standard — READ FIRST
Read **Cascade Web — Architecture & CC Build Spec** in the Confluence **Cascade** space, and honour **UX Psychology — Principles & Cascade Applications** and the honesty guardrail (truthful copy only), before working a ticket.

## Claim the top ticket (Jira)
Tracker: project `CAS` (codynamics.atlassian.net). Credentials are in the environment: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Auth every call with `-u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Accept: application/json"`.
```
project = CAS AND labels = needs-cc-web AND statusCategory != Done ORDER BY priority DESC, key ASC
```
Take the **TOP** ticket (maxResults=1). If none → report **"queue empty"** and **STOP**. Only build tickets labelled `needs-cc-web` (only the active release carries it). The ticket `description` carries the acceptance criteria. Do not depend on Confluence-not-in-spec or attachments — **if a ticket says an asset/spec "will be attached" and it is not in the ticket text, do not invent it: stop and comment that the ticket is blocked on its asset.**

## Work — one ticket only
Implement strictly the ticket's acceptance criteria, in this repo's conventions:
- Front-end → `app_template.html`, then `python poc_pipeline.py --build-html` (regenerates `index.html`; needs no API keys).
- Backend/monitor → `/monitor/` (Python) or `/supabase/schema.sql`. Schema changes that must be applied are a **Lee step** — describe them in the ticket comment; never run SQL against a live project.
- Keep the change scoped to this one ticket. Do not refactor unrelated code.

## Verify — do not ship red (no live secrets)
You do not have Lee's Supabase/Resend keys and must not ask for them. Verify with dry-runs/mocks:
- `python poc_pipeline.py --build-html` exits 0 and renders; auth/storage guarded so the page still loads with no config.
- `python -m monitor --dry-run` and `python -m unittest discover -s monitor/tests` pass.
- SQL: validate it parses; never run against a live project.
Trust exit codes. If you cannot make it green, **revert** (`git checkout -- .`), leave the tree clean, and comment that it needs Lee, with why.

## Hand off — commit + push STAGING, then update Jira
When green:
```bash
git add -A
git commit -m "CAS-XXX: <one-line summary> (staging)"
git push origin staging          # NEVER main
```
This updates the Cloudflare preview. Then in Jira, comment what shipped to staging + any live step Lee must do, and swap labels out of the build queue into Lee's review lane:
```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Content-Type: application/json" -X POST \
  "$JIRA_BASE_URL/rest/api/3/issue/CAS-XXX/comment" \
  -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"CC to staging: <summary>. Review on the preview; promote when happy."}]}]}}'

curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Content-Type: application/json" -X PUT \
  "$JIRA_BASE_URL/rest/api/3/issue/CAS-XXX" \
  -d '{"update":{"labels":[{"remove":"needs-cc-web"},{"add":"on-staging"}]}}'
```
Then return to Claim (next ticket), or stop if the queue is empty.

## Guardrails (hard)
- **One ticket per run.** Never batch. Empty queue → do nothing.
- **Never** touch `main` in any way; never `git checkout main`, merge to main, push main, or force-push anything.
- **Never** edit `.github/workflows/*`, secrets, `config.js`, or the data-pipeline keys. Never print/log secrets. The Supabase **anon** key may live in the front-end; **service_role** + `RESEND_API_KEY` are server-side secrets only.
- **Never invent** a logo, animation, image, or any asset a ticket says will be attached → stop + comment.
- Row-level security stays ON for every user table; the monitor is the only writer of `notifications`.
- Truthful copy only — no fabricated urgency/counts/timers; email de-dupe intact.
- If anything is ambiguous or risky, **stop with a clean tree** and comment rather than guessing.

## Promotion is not yours
You never promote. Lee reviews the Cloudflare preview and runs the **Promote** workflow (or merges `staging → main`) to deploy production. That gate is the whole point.

## Pause switch
If `cloud-cc/PAUSED` exists in the repo, do nothing. Add it to halt CC; delete it to resume.
