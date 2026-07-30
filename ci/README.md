# `ci/` — workflows that need a human to install them

CC is barred from writing `.github/workflows/*` by the autonomy contract (`CC_AUTONOMY_CASCADE_WEB.md`):
a bot that can edit its own CI can edit the gate that checks it. So a workflow CC has written lands here
instead, ready for Lee to move, and does nothing at all until he does.

## qa.yml (CAS-236)

```bash
git mv ci/qa.yml .github/workflows/qa.yml
git commit -m "CAS-236: install the QA workflow"
git push origin staging
```

Then apply the promote gate — the one edit to `promote.yml` that CAS-236 also asks for, added as the first
step of the `promote` job, before the checkout:

```yaml
      - name: Refuse to promote unless staging QA is green
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          sha=$(gh api repos/${{ github.repository }}/commits/staging --jq .sha)
          echo "staging is at $sha"
          concl=$(gh api "repos/${{ github.repository }}/actions/workflows/qa.yml/runs?head_sha=$sha&status=completed" \
                    --jq '.workflow_runs[0].conclusion // "none"')
          echo "QA on that commit: $concl"
          [ "$concl" = "success" ] || { echo "::error::staging QA is '$concl', not success - not promoting"; exit 1; }
```

`gh` is preinstalled on `ubuntu-latest` and `github.token` can read Actions runs, so this needs no new
secret. It fails closed: a commit QA has not finished running on reports `none` and the promote stops.

Nothing else in `promote.yml` changes.
