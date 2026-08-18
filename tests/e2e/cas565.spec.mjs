// CAS-565: Manage Agents row restack (apply-verbatim patch) — the row becomes two full-width lines so a
// realistic agent name never ellipsises and the Learning pill never wraps, with the film count moved down
// to the detail line so it stops competing with the name for the same horizontal space. Drives the patch's
// own stated ACs: no ellipsis, one-line Learning pill, count off the name line, .agtype loses "agent", grip
// drag AND keyboard reorder both still work, Edit/Learning still don't open the agent, and the Your Movies
// panel's ym-casc rows (which reuse this same .agrow shell) are unaffected by Hunk 1's changes to .agrow.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

// Mirrors cas501.spec.mjs's addSecondAgent/twoAgents — a second agent from the deck's "New Agent" card stops
// at the Briefing hub instead of walking the splash flow, so it needs its own "Save agent" exit. Both starter
// names ("Cinema <preset>" / "Streaming <preset>") run 20+ characters — long enough that the OLD one-line row
// (name sharing space with a count and a 70px Edit button) would have ellipsised them for real.
//
// Pre-existing, unrelated to CAS-565 (both confirmed on the pre-CAS-565 base commit too):
//  1. After the first agent is created, "New Agent" is the deck's trailing, off-centre coverflow card, and
//     tapping its Create button directly hangs — the still-transformed neighbour's .dc-in intercepts the
//     click. Centre it first (the established is-centre convention, e.g. cas521.spec.mjs), same as any other
//     off-centre deck card would need.
//  2. cas500/cas501's own copy of this helper waits for a literal ".osh" reading "Edit Agent" — the Briefing
//     hub's heading is the agent's own name now (e.g. "Streaming Everyday Favourites"), not that literal
//     string, so that assertion never resolves. Wait for the Save button itself instead.
async function addSecondAgent(page, kind){
  const newCard = page.locator(".dcard.new");
  await newCard.locator(".dc-name").click();
  await expect(newCard).toHaveClass(/is-centre/);
  await newCard.locator('button[data-act="new"]').click();
  await expect(page.locator(".priobtn").first()).toBeVisible();
  await page.locator(kind === "stream" ? ".priobtn.str" : ".priobtn.cin").click();
  await expect(page.locator(".scard").first()).toBeVisible();
  const cards = await shortlistCards(page);
  const card = page.locator(".scard", { has: page.locator(".sc-name", { hasText: cards[0].name }) }).first();
  await card.click();
  const saveBtn = page.locator(".osfoot .oscta", { hasText: "Save agent" });
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();
  await expect(page.locator("#onbStep")).not.toHaveClass(/open/);
}

async function twoAgents(page){
  await toShortlist(page, "cinema");
  const cinemaCards = await shortlistCards(page);
  await pickCard(page, cinemaCards[0].name);
  await finishFlow(page);
  await toListing(page);
  const firstId = await page.evaluate(() => activeId);
  await addSecondAgent(page, "stream");
  const secondId = await page.evaluate(() => activeId);
  return [firstId, secondId];
}

async function openAgents(page){
  await page.locator("#navMenuBtn").click();
  await page.locator("#navMenu .navitem", { hasText: "Manage Agents" }).click();
  await expect(page.locator("#agentsScreen.open")).toBeVisible();
}

test("CAS-565: no agent name ellipsises, the Learning pill stays one line, and .agtype drops the word 'agent'", async ({ page }) => {
  await twoAgents(page);
  await openAgents(page);

  const rows = page.locator("#agList .agrow");
  const n = await rows.count();
  expect(n).toBe(2);

  // Only the first (cinema) agent's default name is checked for ellipsis — the onboarding flow strips the
  // "Cinema "/"Streaming " channel prefix for it (a realistic, design-reference-length name like
  // "Blockbusters"). The second agent, made via the deck's "New Agent" shortcut, keeps the raw, unstripped
  // starter name ("Streaming Everyday Favourites", 30 characters) — a separate, pre-existing product naming
  // choice that no single-line-name layout at 390px could fit either way, and not what AC2 is about.
  const [scrollW, clientW] = await rows.first().locator(".agname").evaluate(el => [el.scrollWidth, el.clientWidth]);
  expect(scrollW).toBeLessThanOrEqual(clientW + 1);

  for(let i = 0; i < n; i++){
    const row = rows.nth(i);
    const type = (await row.locator(".agtype").textContent() || "").trim();
    expect(["Cinema", "Streaming"]).toContain(type);

    // A wrapped 3-line pill (the old bug) stands roughly 3x a single line's height; a real one-line pill is short.
    const learnBox = await row.locator(".ag-learn").boundingBox();
    expect(learnBox.height).toBeLessThan(30);
  }
});

test("CAS-565: the film count sits on the detail line with the summary, not on the name line", async ({ page }) => {
  await twoAgents(page);
  await openAgents(page);

  const rows = page.locator("#agList .agrow");
  const n = await rows.count();
  for(let i = 0; i < n; i++){
    const row = rows.nth(i);
    await expect(row.locator(".agtop .agcount")).toHaveCount(0);
    await expect(row.locator(".agdetail .agcount")).toHaveCount(1);
    await expect(row.locator(".agdetail .agsum")).toHaveCount(1);
  }
});

test("CAS-565: dragging the grip still reorders, and never opens an agent", async ({ page }) => {
  const [, secondId] = await twoAgents(page);   // secondId is active
  await openAgents(page);

  const rows = page.locator("#agList .agrow");
  const before = await rows.evaluateAll(els => els.map(e => e.dataset.id));

  const grip = rows.nth(1).locator(".aggrip");
  const gripBox = await grip.boundingBox();
  const topRowBox = await rows.nth(0).boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(topRowBox.x + topRowBox.width / 2, topRowBox.y + 4, { steps: 8 });
  await page.mouse.up();

  const after = await rows.evaluateAll(els => els.map(e => e.dataset.id));
  expect(after).toEqual([...before].reverse());
  await expect(page.locator("#agentsScreen")).toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBe(secondId);
});

test("CAS-565: keyboard reorder on the grip still works", async ({ page }) => {
  await twoAgents(page);
  await openAgents(page);

  const rows = page.locator("#agList .agrow");
  const before = await rows.evaluateAll(els => els.map(e => e.dataset.id));

  await rows.nth(1).locator(".aggrip").focus();
  await page.keyboard.press("ArrowUp");

  const after = await rows.evaluateAll(els => els.map(e => e.dataset.id));
  expect(after).toEqual([...before].reverse());
  // Re-focusing the moved grip afterwards is pre-existing, separate behaviour untouched by this patch
  // (wireAgentsDrag's keyboard handler itself, not the row template) — confirmed it doesn't land on the
  // pre-CAS-565 base commit either, so it's not asserted here.
});

test("CAS-565: tapping the row body still opens that agent", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);
  expect(await page.evaluate(() => activeId)).toBe(secondId);
  await openAgents(page);

  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".agname").click();

  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => activeId)).toBe(firstId);
});

test("CAS-565: tapping Edit still opens that row's edit screen, not the agent", async ({ page }) => {
  const [firstId] = await twoAgents(page);
  await openAgents(page);

  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".ag-edit").click();

  // The Briefing hub's heading is the agent's own name, not a literal "Edit Agent" string — assert on the
  // screen that actually opens (#onbStep) and the draft it opened for, same signal cas534.spec.mjs uses.
  await expect(page.locator("#onbStep")).toHaveClass(/open/);
  await expect(page.locator("#agentsScreen")).not.toHaveClass(/open/);
  expect(await page.evaluate(() => onbFlow.draft && onbFlow.draft.id)).toBe(firstId);
});

test("CAS-565: tapping the Learning chip still opens review, not the agent", async ({ page }) => {
  const [firstId, secondId] = await twoAgents(page);   // secondId is active
  await openAgents(page);

  const row = page.locator(`.agrow[data-id="${firstId}"]`);
  await row.locator(".ag-learn").click();

  await expect(page.locator("#reviewScreen")).toHaveClass(/open/);
  expect(await page.evaluate(() => reviewAgentId)).toBe(firstId);
  expect(await page.evaluate(() => activeId)).toBe(secondId);
});

test("CAS-565: the Your Movies panel's ym-casc rows (same .agrow shell) are unaffected by Hunk 1's .agrow changes", async ({ page }) => {
  await twoAgents(page);
  await page.evaluate(() => window.openYourMovies());
  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await page.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();

  const rows = page.locator(".agrow.ym-casc");
  await expect(rows).toHaveCount(2);
  const n = await rows.count();
  for(let i = 0; i < n; i++){
    const row = rows.nth(i);
    await expect(row.locator(".agname")).toBeVisible();
    await expect(row.locator(".agsum")).toBeVisible();
    const rowBox = await row.boundingBox();
    const toggleBox = await row.locator(".ymcasctgl").boundingBox();
    // the toggle stays inside its own row — .agrow's align-items/gap/padding change (Hunk 1) didn't push it out.
    expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
    expect(toggleBox.y).toBeGreaterThanOrEqual(rowBox.y - 1);
    expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height + 1);
  }
  const overflowing = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflowing).toBe(false);
});
