// CAS-232: the e2e harness runs against the BUILT app, served over http, in a real headless browser.
//
// http rather than file:// because the app fetches nothing but a browser treats a file:// origin as opaque, and
// localStorage — which is where every agent, watch status and preference lives — behaves differently there. The
// server is python's own http.server, so the suite needs no web dependency of its own.
//
// One worker: the app's state is localStorage on one origin, so two workers would be two tests writing one
// another's agents. CAS-385: the suite is now a small fixed smoke gate rather than a full regression suite,
// so 2 retries absorb genuine flake instead of the run-once policy the old per-ticket suite used.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.CASCADE_TEST_PORT || 8973);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // No traces, screenshots or video. They are the first thing you want when a run goes red, and they are also
    // ~30MB a failure — which on a full disk turns one real failure into fifteen ENOSPC failures that tell you
    // nothing. Set PWTRACE=1 to turn tracing back on for a single investigation.
    trace: process.env.PWTRACE ? "retain-on-failure" : "off",
    screenshot: "off",
    video: "off",
    // TMDB posters and YouTube thumbnails are the only outbound requests the page makes. They are decoration,
    // they are slow, and a CI box may have no route to them — so they are blocked outright and the suite is
    // never waiting on, or failing because of, someone else's CDN.
    serviceWorkers: "block",
  },
  // CAS-552: Cascade ships to exactly two runtimes, iOS Safari and the Capacitor WKWebView — both WebKit.
  // The old default project ran Blink with a desktop UA at a phone-sized viewport, an engine/input
  // combination that exists nowhere in production (CAS-519 passed here and failed on device — CAS-526).
  // devices["iPhone 13"] sets defaultBrowserType: "webkit", the real iOS UA, isMobile/hasTouch true,
  // deviceScaleFactor 3 and the 390x844 viewport (the reference phone this design is drawn at,
  // CAS-162/200), so the hand-rolled viewport override above is gone — it would only fight the descriptor.
  projects: [
    { name: "ios", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
