// CAS-342: "only show films on my services" (streaming) fix + cheapest-wins rule.
// Stream may only claim a film that is on a streaming service the viewer picked; Rent may only claim one on
// a rental service they picked; and a dual rent+stream title routes to whichever of the two the viewer's
// OWN services actually reaches — the cheaper (already-paid-for) side wins when both do.
//
// The real catalogue carries no title with both a confirmed subscription and a confirmed cheap-rental offer
// at once (see tests/js/data-integrity.test.mjs), so this seeds one synthetic film straight past
// deriveStatus — passes()/primaryStatus()/matchesServices() read only `status`/`offers` off whatever
// they're given — and drives it through the actual shipped engine and DOM, not a stand-in.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

const FAKE_ID = 900342001;

/** Real onboarding flow to get past the splash, then off the agent's own taste criteria onto the plain "All"
 * catalogue view — the unscoped passes()-only listing (scopeRows(), CAS-170) — so nothing here can be
 * accidentally excluded by an agent recipe this ticket has nothing to do with. */
async function toAllCatalogue(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await page.evaluate(() => {
    setActive(ALL_ID); settleFoundView(); clearFilters(); syncFilterUI(); render();
  });
  await settleListing(page);
}

async function seedFilm(page, { streamSvc, rentSvc }){
  await page.evaluate(({ id, streamSvc, rentSvc }) => {
    MOVIES.push({
      tmdb_id: id, title: "Cheapest-Wins Test Film", status: ["rental", "included_streaming"],
      offers: [{ type: "sub", service: streamSvc, price: null }, { type: "rent", service: rentSvc, price: 5.99 }],
    });
  }, { id: FAKE_ID, streamSvc, rentSvc });
}

async function setMyServices(page, { subs, stores }){
  await page.evaluate(({ subs, stores }) => {
    prefs.sub.clear(); subs.forEach(s => prefs.sub.add(s));
    prefs.store.clear(); stores.forEach(s => prefs.store.add(s));
    prefs.on = true; savePrefs(); render();
  }, { subs, stores });
}

const groupOf = (page, id) => page.evaluate(
  id => document.querySelector(`#card-${id}`)?.closest(".group")?.dataset.g ?? null, id);

test.afterEach(async ({ page }) => {
  await page.evaluate(id => {
    const i = MOVIES.findIndex(m => m.tmdb_id === id);
    if(i >= 0) MOVIES.splice(i, 1);
  }, FAKE_ID);
});

test("CAS-342: reachable only through an owned rental — files under Rent, and shows no green Stream bar", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilm(page, { streamSvc: "HBO Max", rentSvc: "Apple TV Store" });
  // Netflix + Apple TV Store picked; the film's only subscription offer is HBO, which nobody here holds.
  await setMyServices(page, { subs: ["Netflix"], stores: ["Apple TV Store"] });
  await settleListing(page);

  await expect(page.locator(`#card-${FAKE_ID}`)).toBeVisible();
  expect(await groupOf(page, FAKE_ID), "an HBO offer nobody here holds still won the Stream section").toBe("rental");

  const bar = page.locator(`#card-${FAKE_ID} .saveline`);
  await expect(bar).toHaveCount(1);
  await expect(bar).toHaveClass(/plain/);
  await expect(bar).toContainText(/Rent for/);
  await expect(bar, "the green bar must not claim HBO Max — nobody here pays for it").not.toContainText(/HBO/);
});

test("CAS-342: owning both sides of a dual title keeps Stream, and names the service you actually have", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilm(page, { streamSvc: "HBO Max", rentSvc: "Apple TV Store" });
  await setMyServices(page, { subs: ["HBO Max"], stores: ["Apple TV Store"] });
  await settleListing(page);

  await expect(page.locator(`#card-${FAKE_ID}`)).toBeVisible();
  expect(await groupOf(page, FAKE_ID), "owning both sides stopped preferring the free (already-paid) one").toBe("included_streaming");

  const bar = page.locator(`#card-${FAKE_ID} .saveline`);
  await expect(bar).not.toHaveClass(/plain/);
  await expect(bar).toContainText(/Included on.*HBO Max/);
});

test("CAS-342: with the scope off, the unscoped default still prefers Stream regardless of who owns what", async ({ page }) => {
  await toAllCatalogue(page);
  await seedFilm(page, { streamSvc: "HBO Max", rentSvc: "Apple TV Store" });
  await page.evaluate(() => { prefs.sub.clear(); prefs.store.clear(); prefs.on = false; savePrefs(); render(); });
  await settleListing(page);

  expect(await groupOf(page, FAKE_ID)).toBe("included_streaming");
});
