// CAS-285: provider attribution is off the cards and stated once in About & credits.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, freshApp } from "./helpers.mjs";

const TMDB_STATEMENT = "This product uses the TMDB API but is not endorsed or certified by TMDB.";

async function toListingWithOffers(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
}

test("CAS-285: no card carries a provider credit, open or closed", async ({ page }) => {
  await toListingWithOffers(page);
  // Open every "where to watch" list on screen — the credit used to live at the foot of each.
  await page.evaluate(() => {
    document.querySelectorAll("#groups .card .wtw").forEach(w => w.classList.add("open"));
    document.querySelectorAll("#groups .card").forEach(c => c.classList.add("expanded"));
  });
  const groups = page.locator("#groups");
  await expect(groups).not.toContainText(/Streaming data by JustWatch/);
  await expect(groups).not.toContainText(/uses the TMDB API/);
  await expect(groups).not.toContainText(/OMDb/);
  await expect(groups).not.toContainText(/Powered by Watchmode/);
  await expect(page.locator("#groups .jwattr")).toHaveCount(0);
});

test("CAS-285: all the film information is still on the card", async ({ page }) => {
  await toListingWithOffers(page);
  const card = page.locator("#groups .card").first();
  await card.scrollIntoViewIfNeeded();
  await card.locator(".title").click();
  // The ticket only concerns provider credits — everything about the film stays.
  await expect(card.locator(".title")).toBeVisible();
  await expect(card.locator(".metaline")).toBeVisible();
  await expect(card.locator(".r-scores")).toBeVisible();
  await expect(card.locator(".bandw")).toBeVisible();
  const hasCredits = await card.locator(".credits, .trailers, .notrailer").count();
  expect(hasCredits, "the expanded card lost its content").toBeGreaterThan(0);
});

test("CAS-285: the offers list still links out to the film's own page", async ({ page }) => {
  await toListingWithOffers(page);
  const links = await page.locator("#groups .wtw .jwgo").count();
  test.skip(links === 0, "no listed film has a JustWatch deep link today");
  const href = await page.locator("#groups .wtw .jwgo").first().getAttribute("href");
  expect(href).toMatch(/^https?:\/\//);
});

test("CAS-285: About & credits carries TMDB's required statement, verbatim", async ({ page }) => {
  await freshApp(page);
  const about = page.locator("#appCredit");
  await expect(about).toHaveCount(1);
  await expect(about).toContainText(TMDB_STATEMENT);
  const link = about.locator('a[href="https://www.themoviedb.org"]');
  await expect(link).toHaveCount(1);
  // Their terms allow only "TMDB" or "The Movie Database" as names for it.
  const text = await about.textContent();
  expect(text).not.toMatch(/themoviedb\.org is|Movie DB|TheMovieDB/i);
});

test("CAS-285: it credits Watchmode and drops OMDb", async ({ page }) => {
  await freshApp(page);
  const about = page.locator("#appCredit");
  await expect(about).toContainText(/Watchmode/);
  await expect(page.locator("body")).not.toContainText(/OMDb/);
});

test("CAS-285: there is exactly ONE place the attribution is stated", async ({ page }) => {
  await freshApp(page);
  // Split rather than regex — the statement contains dots and the point is a literal count.
  const n = await page.evaluate(s => document.body.innerText.split(s).length - 1, TMDB_STATEMENT);
  expect(n, "the required statement appears more than once").toBe(1);
});

test("CAS-285: the credit is legible, and quieter than Cascade's own branding", async ({ page }) => {
  await freshApp(page);
  const sizes = await page.evaluate(() => {
    const about = document.querySelector("#appCredit");
    const brand = document.querySelector(".brand, header h1, .logo, .splashlogo");
    const px = el => el ? parseFloat(getComputedStyle(el).fontSize) : null;
    return { about: px(about), brand: px(brand), display: getComputedStyle(about).display };
  });
  expect(sizes.display, "the attribution must be present, not hidden").not.toBe("none");
  expect(sizes.about, "too small to read is not attribution").toBeGreaterThanOrEqual(10);
  if(sizes.brand !== null){
    expect(sizes.about, "TMDB ask that their mark is less prominent than the app's own branding")
      .toBeLessThanOrEqual(sizes.brand);
  }
});
