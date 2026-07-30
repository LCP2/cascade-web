// CAS-251: two sections, a lead set with more/less, and one entry per service.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard } from "./helpers.mjs";

async function toServices(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await page.evaluate(() => window.gotoStep("services", "none"));
  await expect(page.locator(".osh", { hasText: /My services/i })).toBeVisible();
}

test("CAS-251: rental and streaming are two sections, each leading with the big ones", async ({ page }) => {
  await toServices(page);
  const heads = await page.locator(".svcsech").allTextContents();
  expect(heads).toEqual(["My Rental Services", "My Streaming Services"]);

  // Each section shows its lead set plus a "more" chip, not the whole tail.
  const lead = await page.evaluate(() => SVC_LEAD);
  const subChips = page.locator("#onbStepSvcs .chip.svc");
  await expect(subChips).toHaveCount(lead);
  const more = page.locator("#onbStepSvcs .chip.svcmore");
  await expect(more).toContainText(/\+ \d+ more/);

  // …and "more" really opens the tail, then folds it again.
  const total = await page.evaluate(() => SUB_SERVICES.length);
  await more.click();
  await expect(page.locator("#onbStepSvcs .chip.svc")).toHaveCount(total);
  await expect(page.locator("#onbStepSvcs .chip.svcmore")).toContainText(/less/);
  await page.locator("#onbStepSvcs .chip.svcmore").click();
  await expect(page.locator("#onbStepSvcs .chip.svc")).toHaveCount(lead);
});

test("CAS-251: one chip per service, and picking it covers every variant", async ({ page }) => {
  await toServices(page);
  await page.locator("#onbStepSvcs .chip.svcmore").click();
  const names = await page.locator("#onbStepSvcs .chip.svc").allTextContents();
  expect(new Set(names).size, "the picker shows the same service twice").toBe(names.length);
  for(const n of names){
    expect(n, `${n} is a billing variant, not a service`).not.toMatch(/with Ads|Amazon Channel|Apple TV Channel/i);
  }
  expect(names).toContain("Netflix");

  // Picking Netflix has to satisfy a film the feed lists only under a variant.
  await page.locator("#onbStepSvcs .chip.svc", { hasText: /^Netflix$/ }).click();
  const covered = await page.evaluate(() => {
    const only = MOVIES.filter(m => (m.offers || []).some(o => /^Netflix Standard/.test(o.service))
                                 && !(m.offers || []).some(o => o.service === "Netflix"));
    return { n: only.length, allMatch: only.every(m => matchesServices(m)) };
  });
  if(covered.n) expect(covered.allMatch, "a variant-only film was missed by a Netflix pick").toBe(true);
});

test("CAS-251: the only-my-services switch is not touching the list above it", async ({ page }) => {
  await toServices(page);
  const gap = await page.evaluate(() => {
    const list = document.querySelectorAll(".svcsec")[1].getBoundingClientRect();
    const tog = document.getElementById("onbSvcOnly").getBoundingClientRect();
    return tog.top - list.bottom;
  });
  expect(gap, "the switch is sitting on the service list").toBeGreaterThanOrEqual(12);
});
