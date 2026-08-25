// CAS-609: `notify` (the per-film "Watch it" state) was per-DEVICE, not per-account — signing out never
// cleared it, and the account load only ever unioned film_watch rows in, so a brand-new account inherited
// the previous account's ticks and the next sync pushed them into the new account's own rows.
//
// Guest-mode/network-free (helpers.mjs), stubbing window.CascadeAuth directly and driving the real
// `cascade-auth-change` listener — same pattern as cas561.spec.mjs (cas317.spec.mjs, the pattern this
// ticket named, no longer exists in the tree; cas561 is the current example of the same shape: a fake
// Supabase client hung off window.CascadeAuth, no real network, exercising window.CascadePersistence's
// seams and the app's own top-level state, which lives as bare identifiers in the page's global lexical
// scope — window.notify is undefined, but a bare `notify` resolves fine, exactly like MOVIES/tasteBase
// elsewhere in this suite).
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

const UID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FILM_X = "999001";   // synthetic id — this test only cares about the `notify` object, not a real film

function fakeSignIn({ uid, filmWatchRows }){
  // Every table but film_watch answers with an empty, harmless result — chainable however the real
  // loaders call it (.select().limit()/.order()/.eq()...) and awaitable at any point in that chain.
  function makeChain(rows){
    const chain = {
      select: () => chain, limit: () => chain, order: () => chain,
      eq: () => chain, is: () => chain, in: () => chain, delete: () => chain,
      upsert: () => Promise.resolve({ error: null }),
      then: (resolve) => resolve({ data: rows, error: null }),
    };
    return chain;
  }
  window.CascadeAuth = {
    enabled: true,
    status: "signed-in",
    session: { user: { id: uid } },
    client: { from: (table) => makeChain(table === "film_watch" ? (filmWatchRows || []) : []) },
  };
  window.dispatchEvent(new CustomEvent("cascade-auth-change"));
}

function fakeSignOut(){
  window.CascadeAuth = { enabled: true, status: "guest", session: null, client: null };
  window.dispatchEvent(new CustomEvent("cascade-auth-change"));
}

const hasTruthyWins = (id) => {
  const e = notify[id];
  return !!(e && e.wins && Object.values(e.wins).some(Boolean));
};

test("CAS-609: signing out and into a different account does not carry the old account's Watch-it ticks over", async ({ page }) => {
  await freshApp(page);

  // User A's film_watch row for film X comes down and sets notify[X].wins.
  await page.evaluate(fakeSignIn, { uid: UID_A, filmWatchRows: [{ movie_id: FILM_X, windows: ["stream"] }] });
  await expect.poll(() => page.evaluate((id) => notify[id] && notify[id].wins && notify[id].wins.stream, FILM_X)).toBe(true);

  // Sign out, then into a brand-new account (B) whose film_watch has no rows at all for X.
  await page.evaluate(fakeSignOut);
  await page.evaluate(fakeSignIn, { uid: UID_B, filmWatchRows: [] });

  // B must not inherit A's tick — either no entry for X at all, or one with nothing truthy in `wins`.
  await expect.poll(() => page.evaluate(hasTruthyWins, FILM_X)).toBe(false);
});
