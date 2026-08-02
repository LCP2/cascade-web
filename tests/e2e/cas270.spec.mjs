// CAS-270: the cascade card's sub-line is the count — and, for a streaming agent, what the count is drawn from.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, numberIn } from "./helpers.mjs";

/** The sub-line of whichever deck card is currently centred. */
const centreSub = page =>
  page.locator(".dcard.is-centre .dc-sub").first().textContent().then(s => s.trim());

/** Build an agent of `kind` and land on its listing, with its own card lit in the deck. */
async function toAgentListing(page, kind){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await expect(page.locator(".dcard.is-active").first()).toBeVisible();
}

for(const kind of ["cinema", "stream"]){
  test(`CAS-270: a ${kind} agent's sub-line leads with the film count`, async ({ page }) => {
    await toAgentListing(page, kind);
    const sub = await page.locator(".dcard.is-active .dc-sub").first().textContent();
    expect(sub.trim(), `the sub-line reads "${sub}"`).toMatch(/^\d+ films?\b/);
    expect(numberIn(sub)).not.toBeNull();
  });

  test(`CAS-270: a ${kind} agent's sub-line drops the tense and the alert promise`, async ({ page }) => {
    await toAgentListing(page, kind);
    const sub = (await page.locator(".dcard.is-active .dc-sub").first().textContent()).trim();
    // The four facts that used to be crammed into one 11px line. Only the count survives.
    expect(sub).not.toMatch(/right now|match now/);
    expect(sub, "the alert summary belongs on the Edit screen, not here").not.toMatch(/alert|bell|tell you/i);
  });
}

test("CAS-270: a cinema agent gets the bare count and no scope suffix", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const sub = (await page.locator(".dcard.is-active .dc-sub").first().textContent()).trim();
  expect(sub, `a cinema agent has no services fork to disambiguate — "${sub}"`).toMatch(/^\d+ films?$/);
});

test("CAS-270: a streaming agent says which population the count came from, either way", async ({ page }) => {
  await toAgentListing(page, "stream");
  const sub = (await page.locator(".dcard.is-active .dc-sub").first().textContent()).trim();
  // The point of the ticket: silence is what made "153 films" ambiguous, so BOTH states are spelled out.
  expect(sub, `the stream sub-line reads "${sub}"`).toMatch(/^\d+ films? · (any service|my services)/);

  // And it tracks the agent's own scope rather than being a fixed string.
  const scoped = await page.evaluate(() => anyScope(activeCascade()));
  expect(sub.includes("my services"), `anyScope() is ${scoped}`).toBe(scoped);
});

test("CAS-270: the All card is the count too, with nothing appended", async ({ page }) => {
  await toAgentListing(page, "cinema");
  // Walk the deck back to All, which sits ahead of every agent.
  await page.evaluate(() => deckGo(0, false));
  await expect(page.locator(".dcard.all.is-centre")).toBeVisible();
  const sub = await centreSub(page);
  expect(sub, `the All sub-line reads "${sub}"`).toMatch(/^\d+ films?$/);
  expect(sub).not.toMatch(/a view, not a watch|never alerts you|in the catalogue/);
});

test("CAS-270: the count on the card is the number of films the agent lists", async ({ page }) => {
  await toAgentListing(page, "cinema");
  const sub = await page.locator(".dcard.is-active .dc-sub").first().textContent();
  const shown = await page.evaluate(() => countCriteria(activeCascade()));
  expect(numberIn(sub), "the sub-line must not invent a number of its own").toBe(shown);
});
