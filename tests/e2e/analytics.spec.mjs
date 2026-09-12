// CAS-940: unique session id, one app_open per load, and first-touch acquisition capture.
import { test, expect } from "@playwright/test";

// A local, param-carrying equivalent of helpers.mjs's freshApp/gotoFresh: those two always land the
// SECOND (real) navigation on a bare /index.html, which would itself mint CLIENT_KEY and fire the first
// app_open before this spec's own "first load" ever happens. Same route-block + clear-then-load shape,
// just with the query string threaded through to the load that's actually under test.
async function freshLoad(page, qs){
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto(`/index.html${qs || ""}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
}

const readAcq = page => page.evaluate(() => {
  const v = localStorage.getItem("cascade_acq");
  return v == null ? null : JSON.parse(v);
});
const readLog = page => page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));

test("CAS-940: first-touch acquisition capture, utm stripping, and one app_open per load", async ({ page }) => {
  // AC3a/b: first load with a full utm set.
  await freshLoad(page, "?utm_source=test&utm_medium=cpc&utm_campaign=spring");

  const acq1 = await readAcq(page);
  expect(acq1.src).toBe("test");
  expect(acq1.med).toBe("cpc");
  expect(acq1.cmp).toBe("spring");
  expect(await page.evaluate(() => location.href)).not.toContain("utm_");

  let log = await readLog(page);
  let opens = log.filter(e => e.type === "app_open");
  expect(opens.length).toBe(1);
  expect(opens[0].plat).toBe("web");
  expect(opens[0].ver).not.toBeNull();
  expect(opens[0].ret).toBe(false);
  const firstSession = opens[0].s;

  // AC3c/d/e: reloading with a different utm_source must not overwrite first touch, but still fires
  // exactly one more app_open, this time returning, under a different session.
  await page.goto("/index.html?utm_source=second");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  const acq2 = await readAcq(page);
  expect(acq2.src).toBe("test");
  expect(await page.evaluate(() => location.href)).not.toContain("utm_");

  log = await readLog(page);
  opens = log.filter(e => e.type === "app_open");
  expect(opens.length).toBe(2);
  expect(opens[1].ret).toBe(true);
  expect(opens[1].s).not.toBe(firstSession);
});
