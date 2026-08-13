// CAS-484: a per-film Watch-it tick must become a real, syncable row — not just a local display flag. The
// suite stays guest-mode/network-free (helpers.mjs), so this cannot exercise the live Supabase round trip;
// what it CAN verify without a live account is the exact contract the sync layer is built on:
// window.CascadePersistence.watchRows() (what a push to `film_watch` would upload) and applyWatchRows()
// (what a load-back from a second device applies) — both pure functions over `notify`, reachable in guest
// mode, and exactly the seam a bug in the row shape (wrong movie_id type, a stray key, a level not clearing)
// would show up on.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-484: ticking Watch-it produces the film_watch sync row, and unticking clears it", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("id")).replace(/^card-/, "");

  // Nothing ticked yet — the sync row for this film must not exist at all.
  let rows = await page.evaluate(() => window.CascadePersistence.watchRows());
  expect(rows.find(r => r.movie_id === String(id))).toBeUndefined();

  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await expect(streamRow).toBeVisible();
  if(!(await streamRow.evaluate(el => el.classList.contains("on")))) await streamRow.click();
  await expect(streamRow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  // Ticked: the upload row exists, is keyed by the same id (as a string — the shape the `text` movie_id
  // column and the monitor's transitions both expect), and carries the ticked window.
  rows = await page.evaluate(() => window.CascadePersistence.watchRows());
  const row = rows.find(r => r.movie_id === String(id));
  expect(row).toBeTruthy();
  expect(row.windows).toContain("stream");

  // Untick it — the row must disappear from the upload set entirely (an empty `windows` list is never
  // uploaded as a row; the real sync then deletes the account's copy the same way CAS-408's baseline diff
  // does for every other synced set).
  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRowAgain = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await streamRowAgain.click();
  await expect(streamRowAgain).toHaveAttribute("aria-pressed", "false");

  rows = await page.evaluate(() => window.CascadePersistence.watchRows());
  expect(rows.find(r => r.movie_id === String(id))).toBeUndefined();
});

test("CAS-484: a second device's load-back (applyWatchRows) re-ticks the Watch-it control", async ({ page }) => {
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const id = (await card.getAttribute("id")).replace(/^card-/, "");

  // Simulate what loadFilmWatches()/reconcileFilmWatches() apply after a real Supabase select — a row this
  // device never ticked locally, exactly as it would arrive from another signed-in device.
  await page.evaluate((movieId) => {
    window.CascadePersistence.applyWatchRows([{ movie_id: String(movieId), windows: ["stream"] }]);
  }, id);

  await page.locator(`.ctl.notify[data-nid="${id}"]`).click();
  await expect(page.locator(".cpop.npop")).toBeVisible();
  const streamRow = page.locator('.cpop.npop .nopt[data-wk="stream"]');
  await expect(streamRow).toHaveAttribute("aria-pressed", "true");
  await expect(streamRow).toHaveClass(/on/);
});
