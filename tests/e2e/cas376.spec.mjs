// CAS-376: the collapsed-card stub used to lay out all six rating icons (Wow! / Watch Again / Enjoyed /
// So-so / Disliked / Never) inline next to the title, which squeezed the title unreadable on a phone. The
// stub now shows only the currently-chosen answer's icon, and the freed width goes to the title.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

async function firstCard(page, kind = "cinema"){
  await toShortlist(page, kind);
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  return card;
}

test("CAS-376: the stub shows only the chosen answer's icon, not the full set", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "liked"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(stub).toBeVisible();
  await expect(stub).toContainText("Watch Again");
  await expect(stub.locator(".actbtn"), "only the chosen answer's icon should render, not all six").toHaveCount(1);
  await expect(stub.locator(".actbtn.on.liked")).toHaveCount(1);
});

test("CAS-376: the freed width goes to the title — the icon column is one button wide, not six", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "liked"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  const [stubBox, iconsBox, nameBox] = await Promise.all([
    stub.boundingBox(), stub.locator(".actions").boundingBox(), stub.locator(".stubname").boundingBox(),
  ]);
  // Six 32px icons plus gaps would have run past 200px; one icon-sized column leaves the rest of the row
  // — most of it — to the title.
  expect(iconsBox.width, "the icon column must be a single icon wide, not the old six-across strip").toBeLessThan(40);
  expect(nameBox.width / stubBox.width, "the title must hold most of the row now the icons are freed up")
    .toBeGreaterThan(0.5);
});

test("CAS-376: tapping the icon for a normal rating opens the same rating menu as the full card's Watched chip", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "soso"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await stub.locator(".actbtn").click();
  const pop = stub.locator(".cpop .csegs");
  await expect(pop, "tapping the stub's icon must open the CAS-374 rating menu").toBeVisible();
  const labels = (await pop.locator(".cseg .cl").allTextContents()).map(s => s.trim());
  expect(labels).toEqual(["Wow!", "Watch Again", "Enjoyed", "So-so", "Disliked"]);
  await expect(pop.locator(".cseg.on")).toHaveText(/So-so/);
});

test("CAS-376: picking a different rating from the stub's menu updates the shown icon", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "soso"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await stub.locator(".actbtn").click();
  await stub.locator(".cpop .cseg").filter({ hasText: "Watch Again" }).click();
  await settleListing(page);

  expect(await page.evaluate(i => opinionOf(i), id)).toBe("liked");
  const after = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(after.locator(".actbtn.on.liked")).toHaveCount(1);
});

test("CAS-376: re-picking the same rating in the menu undoes it, same as the full card", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "enjoyed"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await stub.locator(".actbtn").click();
  await stub.locator(".cpop .cseg").filter({ hasText: "Enjoyed" }).click();
  await settleListing(page);

  expect(await page.evaluate(i => opinionOf(i), id)).toBe("");
  await expect(page.locator(`#groups .card[id="card-${id}"]`), "the full card must come back").toHaveCount(1);
});

test("CAS-376: Never keeps its direct tap-to-undo, since the rating menu has no Never row to undo it from", async ({ page }) => {
  const card = await firstCard(page);
  const id = Number((await card.getAttribute("id")).replace("card-", ""));
  await page.evaluate(i => setOpinion(i, "notfor"), id);
  await settleListing(page);

  const stub = page.locator(`#groups .stub[id="card-${id}"]`);
  await expect(stub).toContainText("Never");
  const lit = stub.locator(".actbtn.on.notfor");
  await expect(lit).toHaveCount(1);
  await expect(lit, "Never has no aria-haspopup — it is a direct toggle, not a menu opener")
    .not.toHaveAttribute("aria-haspopup", "true");

  await lit.click();
  await settleListing(page);
  expect(await page.evaluate(i => opinionOf(i), id)).toBe("");
  await expect(page.locator(`#groups .card[id="card-${id}"]`)).toHaveCount(1);
});
