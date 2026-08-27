// CAS-232: shared driving for the e2e specs.
//
// The rule here is that anything a PERSON does, the test clicks — the splash CTA, the priority answer, an agent
// card, Continue. Only reading uses page.evaluate. A harness that drove the flow by calling flowPriority() and
// pickStarter() directly would still pass with every button on the page unwired, which is most of what an
// end-to-end suite is for.
import { expect } from "@playwright/test";

export const PRESET_NAMES = {
  // CAS-261: Nominees & Awards left the cinema lane — the cinema control set is Scale + Buzz, so there was
  // no awards criterion for it to stand on there.
  // CAS-307: Family Movies is the third cinema door, after Blockbusters and Date Night.
  cinema: ["Blockbusters", "Date Night", "Family Movies", "Totally Custom"],
  stream: ["Loved & Acclaimed", "Date Night", "Everyday Favourites", "Nominees & Awards", "Totally Custom"],
};

/** The raw navigation freshApp does, with no opinion on config.js — cas317.spec.mjs needs this bare, since
 * it registers its own config.js/esm.sh routes and a route added later always wins over one added earlier. */
export async function gotoFresh(page){
  await page.goto("/index.html");
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto("/index.html");
  // MOVIES and friends are top-level `const` in a classic script, so they live in the global LEXICAL scope and
  // are NOT properties of window — `window.MOVIES` is undefined while a bare `MOVIES` resolves fine. Worth
  // knowing before writing any page.evaluate against this app; it cost a run to learn.
  await page.waitForFunction(() => typeof flowStart === "function" && Array.isArray(MOVIES));
  return page;
}

/** A first-run app with nothing remembered — the splash, every time. */
export async function freshApp(page){
  // CAS-317: config.js is now a real, committed file carrying production Supabase credentials (that's
  // the ticket's whole point) — but the suite must stay guest-mode and network-free, exactly as it was
  // when config.js didn't exist, or every test would start hitting the live project. Only cas317.spec.mjs
  // opts back in, with a fake config + fake Supabase client of its own (via gotoFresh, above).
  await page.route("**/config.js", route => route.fulfill({ status: 404, body: "" }));
  return gotoFresh(page);
}

/** Read the integer out of a "28 films match right now" / "Continue · 28 films" style string. */
export const numberIn = s => {
  const m = String(s == null ? "" : s).replace(/,/g, "").match(/-?\d+/);
  return m ? Number(m[0]) : null;
};

/** CAS-629: click through the splash and the two roster-briefing screens (S1/S2 — the questions that
 * generate the WHOLE first-run roster at once, not one agent to sharpen), landing on "services" (S4),
 * the new sequence's first counted step. "together" (S3) is walked straight past on the way, since the
 * default answers (`who: ["me"]`) name no partner/kids for it to steer. Kept the name from the old
 * flow's shortlist-of-agents screen this replaces; `kind` only nudges the cinema question now, since
 * every roster this builds is a MIX of agents — there is no lane left to choose. */
export async function toShortlist(page, kind){
  await freshApp(page);
  await page.locator("#splashCta").click();
  await expect(page.locator("#obWho")).toBeVisible();
  if(kind === "stream") await page.locator("#obCinema .chip", { hasText: "never" }).click();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);              // the flow slides between steps
  await expect(page.locator("#obDepth")).toBeVisible();
  await ctaLocator(page).click();
  await page.waitForTimeout(120);
  await expect(page.locator("#onbStepStores")).toBeVisible();
}

/** Every card on the shortlist, as {name, countText, count}. */
export async function shortlistCards(page){
  return page.locator(".scard").evaluateAll(cards => cards.map(c => ({
    name: (c.querySelector(".sc-name")?.textContent || "").replace(/RECOMMENDED/, "").trim(),
    countText: (c.querySelector(".sc-match")?.textContent || "").trim(),
  })));
}

/** Tap the shortlist card whose title starts with `name`, landing on Mission. */
export async function pickCard(page, name){
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: name }) }).first();
  await card.click();
  await expect(page.locator(".osh", { hasText: "Mission" })).toBeVisible();
}

/** The step's own live count, read from the mirror above the controls. */
export const topCount = page => page.locator(".oscount").first().textContent().then(numberIn);

/** Whichever Continue is on screen — the flow's fixed bar, or a preview's own footer button. */
export function ctaLocator(page){
  return page.locator("#flowCta:visible, #onbStepCta:visible").first();
}
export const ctaCount = page => ctaLocator(page).textContent().then(numberIn);

/** Press Continue until the flow ends, landing on the membership page (S7). CAS-629: this now walks
 * services → working (the roster commits here, no click required, but Continue still advances it early)
 * → report → membership — generic enough that no step name needs to be known here. Returns S7's own
 * "worth your time" count (`.membhaul .cnt`, CAS-629 Change E4) — a roster-wide figure now, not one
 * agent's haul. */
export async function finishFlow(page){
  for(let i = 0; i < 15; i++){
    const stillInFlow = await page.evaluate(() => flowOn === true);
    if(!stillInFlow) break;
    await ctaLocator(page).click();
    await page.waitForTimeout(120);          // the flow slides between steps
  }
  await expect(page.locator("#membScreen.open")).toBeVisible();
  const reveal = numberIn(await page.locator(".membhaul .cnt").textContent());
  return reveal;
}

/** Close the membership page and land on the new agent's listing, fully streamed in. */
export async function toListing(page){
  await page.locator(".membcta").click();
  await expect(page.locator("#membScreen.open")).toBeHidden({ timeout: 30_000 });
  await settleListing(page);
}

/** The listing streams its cards in batches, so wait for the count to stop moving. */
export async function settleListing(page){
  await page.waitForFunction(() => {
    const g = document.querySelectorAll("#groups .group").length;
    return g > 0 || document.querySelector("#groups .emptyres, #groups .empty");
  }, null, { timeout: 30_000 });
  let last = -1;
  for(let i = 0; i < 60; i++){
    const n = await page.locator("#groups .card, #groups .stub").count();
    if(n === last) return n;
    last = n;
    await page.waitForTimeout(250);
  }
  return last;
}

/** The listing's section headers, as {window, count}. */
export function sectionCounts(page){
  return page.locator("#groups .group").evaluateAll(gs => gs.map(g => ({
    window: g.dataset.g,
    count: Number((g.querySelector(".gcount")?.textContent || "0").trim()),
  })));
}
