// CAS-514: typing into the cascade search box used to call render() — a full re-filter and listing rebuild —
// synchronously from the input's own `oninput` handler, once per keystroke. On a full catalogue that render
// is heavy enough to block the main thread long enough that the character you just typed visibly lagged
// behind the keypress. The fix debounces the render/filter, not the input's own value — so a burst of
// keystrokes should land in the input in roughly the time it takes to type them, not the time it takes to
// rebuild the whole listing once per character.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

test("CAS-514: the search input keeps up with fast typing against the full catalogue", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);

  // AC2: search against the whole catalogue, not one agent's narrower Found set — switch to All.
  await page.locator(".dcard.all").click();
  await settleListing(page);
  const catalogueSize = await page.evaluate(() => MOVIES.length);
  expect(catalogueSize).toBeGreaterThan(200);   // a real/typical catalogue, not a handful of fixtures

  await page.locator("#cascStrip .dcard.is-centre .dc-search").click();
  const input = page.locator("#cascSearchInput");
  await expect(input).toBeFocused();

  // A short, realistic burst of keystrokes (AC1). If render() were still synchronous per keystroke, the
  // renderer's main thread would be busy rebuilding the whole listing between each character, so dispatching
  // the next keydown -- and thus the character appearing -- would stall behind it.
  const term = "the";
  const start = Date.now();
  await input.pressSequentially(term, { delay: 30 });
  const elapsed = Date.now() - start;
  await expect(input).toHaveValue(term);
  // Typing 3 characters at a 30ms cadence takes ~90ms on its own; give generous headroom above that for CI
  // noise while still being far below what a full synchronous re-render per keystroke would cost.
  expect(elapsed, `typing "${term}" took ${elapsed}ms`).toBeLessThan(1000);

  // The debounced filter still lands, once it settles (AC1 is about the keystroke, not the results).
  await page.waitForTimeout(300);
  const shown = await page.locator("#groups .card, #groups .stub").count();
  expect(shown).toBeGreaterThan(0);
});
