// CAS-561: `tasteBase` (Preferences' Language baseline, CAS-146/CAS-532) and `watchPrefs` (Preferences'
// Where & when Track/Alert flags, CAS-532) were both localStorage-only, so an account-level setting meant
// something different on every device signed in to the same account. CAS-211 had already wired `taste`
// into the `user_prefs` row and its debounced upsert — this ticket adds `watch_windows` to the same row
// and the same chokepoints, fixes a gap where a `user_prefs` row that predates either field (created with
// an empty `taste`/`watch_windows`, e.g. by an old CAS-183/185 device or a CAS-211-era account that never
// touched Preferences) silently read as "the account says clear this" instead of carrying the device's
// local value up, and adds a live-reconcile pull (`reconcileOnReturn`) so a tab left open across another
// device's change converges without a reload.
//
// Merge rule (also stated on the ticket): `user_prefs` is one row per user holding whole-object fields,
// not an array of rows like `cascades` — there is nothing to diff or prune per item, so "last write wins"
// IS the debounced upsert itself. No timestamp column; the account is a plain single-row overwrite.
//
// Guest-mode/network-free (helpers.mjs) — the account fetch is faked via window.CascadeAuth, same pattern
// as cas517.spec.mjs, driving window.CascadePersistence's exposed seams directly.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const FAKE_UID = "33333333-3333-4333-8333-333333333333";

function fakeClient({ selectData, uid }){
  window.__cas561Upserts = [];
  window.CascadeAuth = {
    enabled: true,
    session: { user: { id: uid } },
    client: {
      from(table){
        if(table !== "user_prefs") return { select: async () => ({ data: [], error: null }) };
        return {
          select: () => ({ limit: async () => ({ data: selectData, error: null }) }),
          upsert: async (rows) => { window.__cas561Upserts.push(rows[0]); return { error: null }; },
        };
      },
    },
  };
}

test("CAS-561: an account's taste + watch_windows overwrite a device's stale local baseline on load", async ({ page }) => {
  await freshApp(page);

  // This device's own (stale, pre-sync) local baseline.
  await page.evaluate(() => {
    tasteBase.langs = ["en"];
    saveTasteBase();
    // normCascade() fills in every field matchesCriteria/render() expect — a hand-built partial object
    // is exactly what a real "New Agent" flow never produces.
    cascades.push(normCascade({ id: "44444444-4444-4444-8444-444444444444", name: "Test agent", kind: "cinema" }));
  });

  const remoteTaste = { langs: [] };                              // "all languages" set on another device
  const remoteWatch = { upcoming: { list: true, notify: true } };
  await page.evaluate(fakeClient, {
    uid: FAKE_UID,
    selectData: [{ user_id: FAKE_UID, sub_services: [], store_services: [], services_only: false,
                   taste: remoteTaste, watch_windows: remoteWatch }],
  });
  await page.evaluate(() => window.CascadePersistence.loadUserPrefs());

  expect(await page.evaluate(() => tasteBase.langs)).toEqual([]);
  expect(await page.evaluate(() => watchPrefs.upcoming)).toEqual({ list: true, notify: true });
  // syncWatchPrefsToCascades() ran as part of the load, so an existing agent's cached status moved with it —
  // the same live propagation CAS-532 gives every other Where & when edit.
  expect(await page.evaluate(() => cascades[0].status)).toContain("upcoming");
  // Loading from the account must not itself queue another push — that would be an extra network call for
  // no local change (AC7).
  expect(await page.evaluate(() => window.__cas561Upserts.length)).toBe(0);
});

test("CAS-561: first sign-in with a local baseline and no account row carries the local one up", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => {
    tasteBase.langs = ["ko", "ja"];
    saveTasteBase();
    watchPrefs.rent = { list: true, notify: true };
    saveWatchPrefs();
  });
  await page.evaluate(fakeClient, { uid: FAKE_UID, selectData: [] });   // no row yet — a genuinely new account
  await page.evaluate(() => window.CascadePersistence.loadUserPrefs());
  await page.evaluate(() => window.CascadePersistence.syncUserPrefsNow());   // bypass the 500ms debounce

  const pushed = await page.evaluate(() => window.__cas561Upserts[0]);
  expect(pushed.taste.langs).toEqual(["ko", "ja"]);
  expect(pushed.watch_windows.rent).toEqual({ list: true, notify: true });
});

test("CAS-561: a legacy user_prefs row with no taste/watch_windows carries the local baseline up rather than clearing it", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => {
    tasteBase.langs = ["fr"];
    saveTasteBase();
    watchPrefs.stream = { list: true, notify: false };
    saveWatchPrefs();
  });
  // A row exists (this account already has services set) but was created before taste/watch_windows —
  // both jsonb columns read back as their schema default, {}.
  await page.evaluate(fakeClient, {
    uid: FAKE_UID,
    selectData: [{ user_id: FAKE_UID, sub_services: ["netflix"], store_services: [], services_only: false,
                   taste: {}, watch_windows: {} }],
  });
  await page.evaluate(() => window.CascadePersistence.loadUserPrefs());

  // The account's genuinely-set field (services) is adopted... (prefs.sub is a Set)
  expect(await page.evaluate(() => [...prefs.sub])).toEqual(["netflix"]);
  // ...but the empty taste/watch_windows must NOT be read as "the account says clear this" — this device's
  // local values survive, and are queued to be carried up.
  expect(await page.evaluate(() => tasteBase.langs)).toEqual(["fr"]);
  expect(await page.evaluate(() => watchPrefs.stream)).toEqual({ list: true, notify: false });

  await page.evaluate(() => window.CascadePersistence.syncUserPrefsNow());
  const pushed = await page.evaluate(() => window.__cas561Upserts[0]);
  expect(pushed.taste.langs).toEqual(["fr"]);
  expect(pushed.watch_windows.stream).toEqual({ list: true, notify: false });
});

test("CAS-561: reconcileOnReturn pulls a changed account baseline into an already-open tab, no reload needed", async ({ page }) => {
  await freshApp(page);
  await page.evaluate(() => { tasteBase.langs = ["en"]; saveTasteBase(); });

  // Sign in with today's account state (matches the device — nothing to change yet). watch_windows is
  // non-empty so this load doesn't hit the legacy-row carry-up branch and schedule a push of its own —
  // upTimer must stay clear going into reconcileOnReturn below, the same way it would for a device that
  // has never made a local edit this session.
  await page.evaluate(fakeClient, {
    uid: FAKE_UID,
    selectData: [{ user_id: FAKE_UID, sub_services: [], store_services: [], services_only: false,
                   taste: { langs: ["en"] }, watch_windows: { upcoming: { list: true, notify: false } } }],
  });
  await page.evaluate(() => window.CascadePersistence.loadUserPrefs());
  expect(await page.evaluate(() => tasteBase.langs)).toEqual(["en"]);

  // Another device now widens Language — this tab never reloads, so the only way it can find out is the
  // same "return to the tab" convergence CAS-408 gives cascades.
  await page.evaluate(fakeClient, {
    uid: FAKE_UID,
    selectData: [{ user_id: FAKE_UID, sub_services: [], store_services: [], services_only: false,
                   taste: { langs: [] }, watch_windows: {} }],
  });
  await page.evaluate(() => window.CascadePersistence.reconcileOnReturn());
  await expect.poll(() => page.evaluate(() => tasteBase.langs)).toEqual([]);
});
