// CAS-1000: Cloudflare Worker that dispatches uptime.yml, daily.yml and alerts.yml on time via
// GitHub's workflow_dispatch API. GitHub's own `schedule` trigger is not dependable for this repo
// (see the ticket) — workflow_dispatch events are not subject to the same delay.
//
// Cron Triggers (UTC, declared in wrangler.toml):
//   17 * * * *  -> uptime.yml every hour
//   0 20 * * *  -> daily.yml once a day
//   0 6 * * *   -> alerts.yml, ONLY if this instant is 17:00 in Australia/Sydney (AEDT)
//   0 7 * * *   -> alerts.yml, ONLY if this instant is 17:00 in Australia/Sydney (AEST)
// Exactly one of the last two fires per day across the daylight-saving switch, computed with
// Intl.DateTimeFormat rather than a fixed UTC offset.

export const REPO = "LCP2/cascade-web";
export const GITHUB_API = "https://api.github.com";
export const RESEND_API = "https://api.resend.com/emails";
export const USER_AGENT = "cascade-scheduler-worker/1.0 (+https://cascademovies.com)";
export const RETRY_DELAY_MS = 30000;

export const CRON = {
  UPTIME: "17 * * * *",
  DAILY: "0 20 * * *",
  ALERTS_A: "0 6 * * *",
  ALERTS_B: "0 7 * * *",
};

const WORKFLOW_FOR_CRON = {
  [CRON.UPTIME]: "uptime.yml",
  [CRON.DAILY]: "daily.yml",
};

// The Sydney local hour (0-23) at `epochMs`, DST-aware via the runtime's own tz database.
export function sydneyHour(epochMs) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  return Number(parts.find((p) => p.type === "hour").value);
}

// Which workflow file (if any) this cron firing, at this instant, should dispatch.
export function targetForCron(cron, epochMs) {
  if (cron === CRON.ALERTS_A || cron === CRON.ALERTS_B) {
    return sydneyHour(epochMs) === 17 ? "alerts.yml" : null;
  }
  return WORKFLOW_FOR_CRON[cron] ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchOnce(env, workflowFile, fetchImpl) {
  const url = `${GITHUB_API}/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GH_DISPATCH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ ref: "main" }),
    });
    if (res.status === 204) return { ok: true, status: 204, body: "" };
    let body = "";
    try {
      body = await res.text();
    } catch {
      // best-effort only — the status code is what matters for the retry/alert decision
    }
    return { ok: false, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String((err && err.message) || err) };
  }
}

async function sendFailureAlert(env, workflowFile, result, fetchImpl) {
  const payload = {
    from: env.ALERT_FROM,
    to: [env.ALERT_TO],
    subject: `Cascade scheduler: ${workflowFile} dispatch failed`,
    text: `Dispatching ${workflowFile} to GitHub failed twice.\nStatus: ${result.status}\nBody: ${result.body}`,
  };
  try {
    await fetchImpl(RESEND_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.log(`scheduler: alert email itself failed for ${workflowFile}: ${(err && err.message) || err}`);
  }
}

// Dispatches `workflowFile` on `main`, retrying once after RETRY_DELAY_MS on any non-204 response
// or thrown error, then emailing ALERT_TO if it still fails. Never throws.
export async function dispatchWorkflow(env, workflowFile, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const sleepImpl = deps.sleep || sleep;

  let result = await dispatchOnce(env, workflowFile, fetchImpl);
  console.log(`scheduler: dispatch ${workflowFile} attempt 1 -> ${result.ok ? 204 : result.status}`);
  if (result.ok) return result;

  await sleepImpl(RETRY_DELAY_MS);
  result = await dispatchOnce(env, workflowFile, fetchImpl);
  console.log(`scheduler: dispatch ${workflowFile} attempt 2 -> ${result.ok ? 204 : result.status}`);
  if (result.ok) return result;

  console.log(`scheduler: dispatch ${workflowFile} failed twice, emailing ${env.ALERT_TO}`);
  await sendFailureAlert(env, workflowFile, result, fetchImpl);
  return result;
}

export default {
  async scheduled(event, env) {
    const workflowFile = targetForCron(event.cron, event.scheduledTime ?? Date.now());
    if (!workflowFile) {
      console.log(`scheduler: cron "${event.cron}" fired, no dispatch (not 17:00 Sydney)`);
      return;
    }
    try {
      await dispatchWorkflow(env, workflowFile);
    } catch (err) {
      // Belt-and-braces: dispatchWorkflow already catches its own errors, but the handler must
      // never throw out silently regardless.
      console.log(`scheduler: unexpected error dispatching ${workflowFile}: ${(err && err.message) || err}`);
    }
  },
};
