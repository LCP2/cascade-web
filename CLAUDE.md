# CLAUDE.md — Cascade (web)

Follows **The Codynamics Development Standard** (Confluence space **DM**). Read the Standard + this file before acting.
Landing: https://codynamics.atlassian.net/wiki/spaces/DM/overview

## The money rule (non-negotiable)
Never poll on a timer, watch progress on a schedule, or run QA/deploy from a Claude session. CI does that; a free Jira REST poll checks the queue. Tokens buy judgement only — shaping, review, debugging.

## Folders
- **Code (this repo):** `C:\Dev\cascade-web` — git remote `LCP2/cascade-web`. Local disk only; never sync to OneDrive.
- **Docs:** `OneDrive\Claude\Cascade`.
- **Tooling:** the bootstrap-kit folder `OneDrive\Claude\Claude Management\bootstrap-kit` (OneDrive-synced master copy; there is no dev-bootstrap repo).
- **Secrets:** GitHub Actions secrets / vault — never in the repo.
- Do not touch `C:\Dev\cascade-movies` or `C:\Claude\Cascade` — see the migration runbook about consolidating the duplicate Cascade repos.

## Parameters
- Jira: project **CAS**
- Build-ready label: **`needs-cc-web`** · human-block `needs-lee`
- Branches: `staging` (workers write) / `main` (promote job only)
- Verify / QA: `npm run qa`
- Build: `python poc_pipeline.py --build-html`
- Deploy: `main` → GitHub Pages → **cascademovies.com**
- **Releases:** cut by pushing tag `vX.Y.Z` (stamps `VERSION`, deploys). Tracked in Jira by a **per-release label** `v<version>` on every ticket in that release — filter the board's **Label** chip to see a release. The current release number is the repo's `VERSION` file / latest tag — don't hardcode it. No Jira Versions, no quick filters.
- CC workers: **1** (web); a shared pool of 2 is possible but needs the atomic ticket-claim step.
- Not the dev pipeline: `daily.yml` (daily AU catalogue refresh) is the **product**; keep it separate.

## Setup / update
Copy the files from `OneDrive\Claude\Claude Management\bootstrap-kit` (or recreate them from the Bootstrap Kit page) → read the Bootstrap Kit page + the CAS parameters row → install into this repo, filling `pipeline.config.json`. Never commit secrets. Releases use labels (above), so the kit's `jira_release.py` is not used here.
