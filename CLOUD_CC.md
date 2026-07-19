# CLOUD_CC.md — Cloud CC autonomy contract (runs in GitHub Actions)

> You are **Cloud CC**: the autonomous builder for `LCP2/cascade-web`, running **inside a GitHub Actions runner** on a fresh checkout of this repo. There is no human watching this run. Your job is to take **one** queued ticket from planning to a **verified, deployable change left staged in the working tree**. The workflow commits + pushes it to `main` for you (that is what deploys the site via GitHub Pages) — so you must **never** `git commit`, `git push`, open a PR, or touch `.github/workflows/*`.
> This is the cloud twin of `CC_AUTONOMY_CASCADE_WEB.md`. Same lane, same guardrails; only the runner and the commit mechanism differ.

## The queue lives in Jira (this is how work reaches you while Lee is mobile)
Lee grooms the backlog remotely. Credentials are in the environment: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`. Authenticate every call with HTTP basic auth `-u "$JIRA_EMAIL:$JIRA_API_TOKEN"` and `-H "Accept: application/json"`.

**Claim the top ticket:**
```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Accept: application/json" \
  --get "$JIRA_BASE_URL/rest/api/3/search" \
  --data-urlencode 'jql=project = CAS AND labels = needs-cc-web AND statusCategory != Done ORDER BY priority DESC, key ASC' \
  --data-urlencode 'maxResults=1' \
  --data-urlencode 'fields=summary,description,priority,labels'
```
If `issues` is empty → **make no changes and stop** (print "queue empty"). Otherwise take that one issue. Its `description` is written to be self-contained: it carries the acceptance criteria you build to. (Do not depend on Confluence ↔ CI cannot read it.)

## Work (one ticket only)
Implement strictly what the ticket's acceptance criteria describe, following this repo's existing conventions:
- **Front-end changes go in `app_template.html`**, then rebuild the served page:
  ```bash
  python poc_pipeline.py --build-html      # regenerates index.html ↔ this build step needs NO API keys
  ```
- **Monitoring / backend changes go in `/monitor/`** (Python) or `/supabase/schema.sql`. Schema changes that need applying are a **Lee step** ↔ describe them in your ticket comment; never run SQL against a live project.
- Keep the change **scoped to this one ticket**. Do not refactor unrelated code.

## Verify ↔ you get no second chances, so do not ship red
- Front-end: `python poc_pipeline.py --build-html` must exit 0 and produce a valid `index.html`.
- Monitor: `python -m monitor --dry-run` (and `python -m unittest discover -s monitor/tests`) must still pass.
- Trust exit codes and passing tests ↔ never assume success. If you cannot make it green, **revert your edits** (`git checkout -- .`), leave the tree clean, and comment on the ticket that it needs Lee, explaining why. A clean tree = nothing deploys = safe.

## Hand off (you do NOT commit)
When green, **leave your edits staged in the working tree** and stop ↔ the workflow's next step commits and pushes to `main`, which redeploys Pages. Then update Jira via the API: add a comment summarising what shipped + any **live step Lee must do** (e.g. "run this SQL", "add secret X"), and swap the labels so it leaves your queue:
```bash
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Content-Type: application/json" -X POST \
  "$JIRA_BASE_URL/rest/api/3/issue/CAS-XXX/comment" \
  -d '{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Cloud CC: <summary>"}]}]}}'

curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" -H "Content-Type: application/json" -X PUT \
  "$JIRA_BASE_URL/rest/api/3/issue/CAS-XXX" \
  -d '{"update":{"labels":[{"remove":"needs-cc-web"},{"add":"needs-lee"}]}}'
```

## Guardrails (hard)
- **One ticket per run.** Never batch. If the queue is empty, do nothing.
- **Never** `git commit` / `git push` / open a PR / edit `.github/workflows/*` ↔ the workflow owns deployment; workflow edits are out of scope and can't be pushed anyway.
- **Never** print, echo, log, or write secrets (`ANTHROPIC_API_KEY`, `JIRA_API_TOKEN`, any Supabase/Resend key). They are not yours to handle beyond the authenticated curls above.
- **Stay in lane:** this stream owns `LCP2/cascade-web` and only `needs-cc-web` tickets. Do not touch `cascade-movies` or `cascade`.
- **Honesty guardrail:** truthful UI copy only ↔ no fabricated urgency or "leaving soon" timers; de-dupe stays intact.
- **Row-level security stays ON** for every user table; the monitor is the only writer of `notifications`.
- If anything is ambiguous or risky, prefer to **stop with a clean tree** and leave a `needs-lee` comment over guessing.

## Pause switch
If a file `cloud-cc/PAUSED` exists in the repo, the workflow skips before you ever start. To halt Cloud CC, add that file; to resume, delete it.

