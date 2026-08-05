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
    // 390x844 is the reference phone the whole design is drawn at (CAS-162/200).
    ...devices["Desktop Chrome"],
    viewport: { width: 390, height: 844 },
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
  webServer: {
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
