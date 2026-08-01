<#
  run-cc.ps1 — Codynamics autonomous worker wrapper.
  The keep-alive loop: launches ONE Claude Code run per ticket, forever.
  Nothing inside an agent can restart a quiet agent, so this external loop must.

  Reads pipeline.config.json from the repo root.
  Secrets come from the environment (NEVER commit these):
      JIRA_EMAIL       your Atlassian login email
      JIRA_API_TOKEN   an Atlassian API token (id.atlassian.com -> API tokens)

  Run one per role, e.g.:
      $env:JIRA_EMAIL="lee@codynamics.com.au"; $env:JIRA_API_TOKEN="..."
      pwsh ./run-cc.ps1 -Role web
#>
param(
  [string]$Role = "web",
  [string]$ConfigPath = "./pipeline.config.json"
)

$ErrorActionPreference = "Stop"
$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path "./logs" | Out-Null

# --- single-instance mutex: one loop per role ---
$lock = Join-Path $env:TEMP "cc-worker-$($cfg.jiraProjectKey)-$Role.lock"
if (Test-Path $lock) { Write-Host "Worker '$Role' already running ($lock). Exiting."; exit 0 }
New-Item -ItemType File -Path $lock | Out-Null

try {
  # A project with several disciplines routes by needs-cc-<role>; a single-toolchain
  # project with pullLabels of length 1 just uses that one label (shared pool).
  $pullLabel = if ($cfg.pullLabels.Count -gt 1) { "needs-cc-$Role" } else { $cfg.pullLabels[0] }
  $jql = "project = $($cfg.jiraProjectKey) AND status = `"$($cfg.readyStatus)`" AND labels = `"$pullLabel`""

  $authBytes = [Text.Encoding]::ASCII.GetBytes("$($env:JIRA_EMAIL):$($env:JIRA_API_TOKEN)")
  $headers = @{ Authorization = "Basic " + [Convert]::ToBase64String($authBytes); Accept = "application/json" }

  while ($true) {
    # === ZERO-USAGE IDLE CHECK ===============================================
    # Ask Jira (plain REST, NO model) whether work exists BEFORE spending a token.
    try {
      $uri = "$($cfg.jiraBaseUrl)/rest/api/3/search?jql=$([uri]::EscapeDataString($jql))&maxResults=0"
      $count = (Invoke-RestMethod -Uri $uri -Headers $headers -Method Get).total
    } catch {
      Write-Warning "Jira poll failed: $_  (fail-open, retry after idle)."
      Start-Sleep -Seconds $cfg.idleSleepSeconds; continue
    }

    if ($count -lt 1) {
      Write-Host "[$(Get-Date -Format o)] role=$Role  no work — sleeping $($cfg.idleSleepSeconds)s (0 tokens)."
      Start-Sleep -Seconds $cfg.idleSleepSeconds; continue
    }

    Write-Host "[$(Get-Date -Format o)] role=$Role  $count ready — launching Claude Code."
    git fetch origin $cfg.integrationBranch --quiet
    $before = git rev-parse "origin/$($cfg.integrationBranch)"

    # The rendered contract (placeholders already filled — see CC_AUTONOMY.md).
    $prompt = Get-Content "./CC_AUTONOMY.md" -Raw

    # Launch Claude Code headless, one ticket, bounded turns, cheapest capable model.
    # Adjust flags to your Claude Code version.
    $out = claude -p $prompt --max-turns $cfg.maxTurns --model $cfg.model 2>&1
    $out | Tee-Object -FilePath "./logs/cc-$Role.log" -Append | Out-Null

    # === FALSE-COMPLETION GUARD ==============================================
    # A DONE claim must actually have moved the integration branch.
    git fetch origin $cfg.integrationBranch --quiet
    $after = git rev-parse "origin/$($cfg.integrationBranch)"
    if (($out -match "DONE") -and ($before -eq $after)) {
      Write-Warning "FALSE COMPLETION: agent claimed DONE but origin/$($cfg.integrationBranch) did not move."
      # (optional) add a Jira comment / raise an alert here.
    }

    Start-Sleep -Seconds 5
  }
}
finally {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}
