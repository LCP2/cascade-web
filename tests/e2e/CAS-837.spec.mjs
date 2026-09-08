// CAS-837: an invite link now carries the sender's ref code (?inv=<code>) and its arrival is recorded —
// no invite row, no "you were invited" screen, no reward (CAS-808 owns that). Mirrors the fake-config/
// fake-supabase-js technique CAS-740/CAS-835's specs use (see CAS740_FAKE_SUPABASE_GLOBAL in smoke.spec.mjs)
// for the signed-in half; the boot/arrival half needs no account at all.
import { test, expect } from "@playwright/test";
import { freshApp, gotoFresh } from "./helpers.mjs";

async function knownFilmId(page){
  await freshApp(page);
  return page.evaluate(() => MOVIES[0].tmdb_id);
}

// AC5a: loading /?inv=<code>#/film/<id> leaves location.search empty, leaves the film page open on that
// id, and leaves the code at localStorage.cascade_inv.
test("CAS-837 AC5a: an invite link's arrival strips ?inv, opens the film page, and is stored", async ({ page }) => {
  const id = await knownFilmId(page);
  await page.goto(`/index.html?inv=abc12345#/film/${id}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));

  expect(await page.evaluate(() => location.search)).toBe("");
  expect(await page.evaluate(() => location.hash)).toBe(`#/film/${id}`);
  await expect(page.locator("#filmPage")).toHaveClass(/open/);
  expect(await page.evaluate(() => localStorage.getItem("cascade_inv"))).toBe("abc12345");
});

// AC5b: a subsequent load with no inv parameter does not clear cascade_inv.
test("CAS-837 AC5b: a later load with no inv parameter does not clear cascade_inv", async ({ page }) => {
  const id = await knownFilmId(page);
  await page.goto(`/index.html?inv=abc12345#/film/${id}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => localStorage.getItem("cascade_inv"))).toBe("abc12345");

  await page.goto("/index.html");
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  expect(await page.evaluate(() => localStorage.getItem("cascade_inv"))).toBe("abc12345");
});

// Change 5 (Acceptance criteria): invite_arrival fires exactly once for a load carrying inv, and not at
// all for a load without it.
test("CAS-837: invite_arrival fires exactly once for a load carrying inv", async ({ page }) => {
  const id = await knownFilmId(page);
  await page.goto(`/index.html?inv=zzz99999#/film/${id}`);
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
  expect(log.filter(e => e.type === "invite_arrival").length).toBe(1);
});

test("CAS-837: invite_arrival does not fire for a load without inv", async ({ page }) => {
  await freshApp(page);
  const log = await page.evaluate(() => JSON.parse(localStorage.getItem("cascade_log") || "[]"));
  expect(log.filter(e => e.type === "invite_arrival").length).toBe(0);
});

// AC5d: signed out, shareUrlFor carries no query string — unchanged from before this ticket.
test("CAS-837 AC5d: signed out, shareUrlFor carries no query string", async ({ page }) => {
  await freshApp(page);
  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  const url = await page.evaluate(fid => shareUrlFor(MOVIES.find(m => m.tmdb_id === fid)), id);
  const expected = await page.evaluate(fid => `${location.origin}${location.pathname}#/film/${fid}`, id);
  expect(url).toBe(expected);
});

// AC5e: opening the film page renders a share control, and activating it does not throw.
test("CAS-837 AC5e: the film page renders a share control that does not throw when activated", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));
  await freshApp(page);
  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  await page.evaluate(fid => openFilmPage(fid), id);

  const shareBtn = page.locator("#filmPage .exsharebtn");
  await expect(shareBtn).toBeVisible();
  await shareBtn.click();
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
});

// AC5c: with CascadeAuth signed in and its account's user_prefs row already carrying ref_code "testcode",
// shareUrlFor for a known film returns exactly <origin><pathname>?inv=testcode#/film/<its tmdb_id>.
const CAS837_FAKE_SUPABASE_GLOBAL = `
  function chain(){
    return new Proxy(() => {}, {
      get: (_t, prop) => prop === "then" ? (resolve) => resolve({ data: [], error: null }) : () => chain(),
      apply: () => chain(),
    });
  }
  window.supabase = { createClient(){
    return {
      auth: {
        getSession: () => Promise.resolve({ data: { session: {
          user: { id: "cas837-user", email: "cas837@example.com" }, access_token: "fake" } } }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe(){} } } }),
        signInWithPassword: async () => ({ data: {}, error: null }),
        signUp: async () => ({ data: {}, error: null }),
        signOut: async () => ({ error: null }),
      },
      from: (table) => table === "user_prefs"
        ? { select: () => ({ limit: () => Promise.resolve({ data: [{ ref_code: "testcode" }], error: null }) }),
            upsert: () => chain() }
        : chain(),
    };
  } };
`;

test("CAS-837 AC5c: signed in with an account ref_code already set, shareUrlFor carries ?inv=<that code>", async ({ page }) => {
  await page.route("**/config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.CASCADE_CONFIG = { SUPABASE_URL: "https://fake-project.supabase.test", SUPABASE_ANON_KEY: "fake-anon-key-not-a-real-secret" };`,
  }));
  await page.route("**/supabase-js.js", route => route.fulfill({
    contentType: "application/javascript",
    body: CAS837_FAKE_SUPABASE_GLOBAL,
  }));
  await gotoFresh(page);
  await page.waitForFunction(() => window.CascadeAuth && window.CascadeAuth.status === "signed-in", null, { timeout: 5000 });
  await page.waitForFunction(() => refCode() === "testcode", null, { timeout: 5000 });

  const id = await page.evaluate(() => MOVIES[0].tmdb_id);
  const url = await page.evaluate(fid => shareUrlFor(MOVIES.find(m => m.tmdb_id === fid)), id);
  const expected = await page.evaluate(fid => `${location.origin}${location.pathname}?inv=testcode#/film/${fid}`, id);
  expect(url).toBe(expected);
});
