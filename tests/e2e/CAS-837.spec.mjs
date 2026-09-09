// CAS-837: an invite link carries a code in ?inv= and its arrival is recorded — that part of this ticket
// still holds. CAS-883 superseded the rest: an invite is now a real record (public.invites) with a
// per-send TOKEN in ?inv=, not the account-level ref code shareUrlFor() used to build here — that function
// is gone, replaced by inviteUrlFor(), and the AC5c/5d/5e tests that pinned its old ref-code behaviour and
// the guest-mode share button are removed below; CAS-883.spec.mjs covers their replacement (the Invite
// sheet, the token, the signed-in gate) instead. What's left is the arrival tracking, which the token's
// arrival still goes through unchanged.
import { test, expect } from "@playwright/test";
import { freshApp } from "./helpers.mjs";

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
