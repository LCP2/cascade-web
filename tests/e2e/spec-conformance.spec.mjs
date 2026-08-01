// CAS-232 part C: the v0.8.1 decisions, asserted on the built page.
//
// Every one of these is a bug that reached production once. They are cheap to check and each of them was
// invisible to every other kind of test we have, because each was a screen that rendered perfectly and said
// the wrong thing.
import { test, expect } from "@playwright/test";
import { freshApp, toShortlist, shortlistCards, pickCard, finishFlow, toListing } from "./helpers.mjs";

test("CAS-215: the splash offers both doors", async ({ page }) => {
  await freshApp(page);
  const signup = page.locator("#splashCta");
  const login = page.locator("#splashLogin");
  await expect(signup).toBeVisible();
  await expect(login).toBeVisible();
  await expect(signup).toContainText(/sign up/i);
  await expect(login).toContainText(/log in/i);
  // The regression was a guard that hid Log in when no account config was present — which is exactly the state
  // this suite runs in (no config.js is served), so a plain visibility check is the real test.
  const configured = await page.evaluate(() => !!(window.CascadeAuth && window.CascadeAuth.enabled));
  expect(configured, "this assertion only means something with accounts unconfigured").toBe(false);
});

test("CAS-217: no vertical frame lines on the app shell", async ({ page }) => {
  await freshApp(page);
  const borders = await page.evaluate(() => {
    const p = document.querySelector(".phone");
    if(!p) return null;
    const cs = getComputedStyle(p);
    return { left: cs.borderLeftWidth, right: cs.borderRightWidth, style: cs.borderLeftStyle };
  });
  expect(borders, "no .phone shell found").not.toBeNull();
  expect(borders.left).toBe("0px");
  expect(borders.right).toBe("0px");
});

test("CAS-216: the poster wall fills the screen and carries no z-rotation", async ({ page }) => {
  await freshApp(page);
  const wall = await page.evaluate(() => {
    const g = document.getElementById("splashWall");
    if(!g) return null;
    const r = g.getBoundingClientRect();
    return { tiles: g.childElementCount, top: r.top, bottom: r.bottom, vh: window.innerHeight,
             transform: getComputedStyle(g).transform,
             fade: getComputedStyle(document.querySelector(".splashfade")).backgroundImage };
  });
  expect(wall).not.toBeNull();
  expect(wall.tiles).toBeGreaterThanOrEqual(48);
  expect(wall.top, "the wall must over-fill the top").toBeLessThanOrEqual(0);
  expect(wall.bottom, "the wall must reach the bottom edge").toBeGreaterThanOrEqual(wall.vh);
  expect(wall.transform).not.toMatch(/rotateZ/i);
  // The fade must never reach solid, or the bottom of the splash goes black again.
  expect(wall.fade).not.toMatch(/rgb\(8, 11, 20\)\s/);
});

// CAS-220 asserted that a cinema Mission has no More controls and a streaming one does. CAS-248 removed
// Buzz from the streaming lane, which was the only thing streaming's More controls held — so the second
// half of that claim is now false by design, and the property CAS-220 was really protecting survives: each
// lane offers exactly the dials it uses, and neither hides one behind a disclosure.
test("CAS-220 / CAS-248: each Mission offers its own lane's dials, and no More controls", async ({ page }) => {
  await toShortlist(page, "cinema");
  let cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await expect(page.locator(".osmore")).toHaveCount(0);
  await expect(page.locator(".dialcard, [data-dial]")).toHaveCount(2);

  await toShortlist(page, "stream");
  cards = await shortlistCards(page);
  await pickCard(page, cards.find(c => /Everyday/.test(c.name))?.name || cards[0].name);
  await expect(page.locator(".osmore")).toHaveCount(0);
  await expect(page.locator(".dialcard, [data-dial]")).toHaveCount(3);
  await expect(page.locator("#onbStep")).not.toContainText(/Buzz/i);
});

test("CAS-225 / CAS-223: Ratings drops Select all; Style keeps it, below its chips", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);

  // Walk to Style, then Ratings, pressing the flow's own Continue.
  const step = () => page.evaluate(() => onbStepKey);
  for(let i = 0; i < 8 && await step() !== "genres"; i++){
    await page.locator("#flowCta:visible, #onbStepCta:visible").first().click();
    await page.waitForTimeout(120);
  }
  expect(await step()).toBe("genres");
  await expect(page.locator(".tbq.tbqmin")).toHaveCount(1);
  // CAS-223: the rule belongs UNDER the controls, so it separates chips+controls from the summary.
  const rule = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".tbq.tbqmin"));
    return { top: cs.borderTopWidth, bottom: cs.borderBottomWidth };
  });
  expect(rule.top).toBe("0px");
  expect(Number.parseFloat(rule.bottom)).toBeGreaterThan(0);

  for(let i = 0; i < 8 && await step() !== "age"; i++){
    await page.locator("#flowCta:visible, #onbStepCta:visible").first().click();
    await page.waitForTimeout(120);
  }
  expect(await step()).toBe("age");
  await expect(page.locator(".tbq.tbqmin"), "Ratings must have no Select all row").toHaveCount(0);
  await expect(page.locator(".ossumline.ruled"), "…but must keep its divider").toHaveCount(1);
});

test("CAS-228: Agent Settings shows only the agent type's own windows, each with List and Notify", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  // Edit → the Briefing → Agent settings. Reached the way a person reaches it.
  await page.evaluate(() => window.editCascade());
  await expect(page.locator(".osh", { hasText: /Edit Agent/ })).toBeVisible();   // CAS-266 renamed it
  await page.locator(".osdoor", { hasText: "Agent settings" }).click();
  await expect(page.locator(".osh", { hasText: /Where & when/ })).toBeVisible();

  const windows = await page.locator("#wwLanes .wwlane").evaluateAll(ls => ls.map(l => ({
    name: (l.querySelector(".wwn")?.textContent || "").trim(),
    switches: [...l.querySelectorAll(".agwt")].map(b => b.textContent.trim()),
  })));
  expect(windows.map(w => w.name)).toEqual(["Upcoming", "In cinema"]);
  for(const w of windows){
    expect(w.switches.length, `${w.name} must carry exactly two switches`).toBe(2);
    expect(w.switches.join(" ")).toMatch(/List/);
    expect(w.switches.join(" ")).toMatch(/Notify/);
  }
  // A cinema agent must never be offered a home window here.
  await expect(page.locator("#wwLanes")).not.toContainText(/Rent|Streaming/);

  // The two switches are independent: turning List off must leave Notify on and the window still watched.
  await page.locator("#wwLanes .wwlane", { hasText: "Upcoming" }).locator(".agwt", { hasText: "List" }).click();
  const state = await page.evaluate(() => {
    const d = onbApply();
    return { list: d.listStatus, watch: d.status, ww: onbFlow.watch };
  });
  expect(state.ww.upcoming.list).toBe(false);
  expect(state.ww.upcoming.notify).toBe(true);
  expect(state.watch, "a notify-only window must still be watched").toContain("upcoming");
  expect(state.list, "…but must not be listed").not.toContain("upcoming");
});

test("CAS-230: the film card carries Watch status + Notify + chevron, not the old icon row", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);

  const first = page.locator("#groups .card").first();
  await expect(first).toBeVisible();
  const controls = await first.locator(".actions > *").evaluateAll(els => els.map(e => ({
    cls: e.className, text: (e.textContent || "").trim(),
  })));
  expect(controls.length, JSON.stringify(controls)).toBe(3);
  expect(controls[0].cls).toMatch(/\bctl\b.*\bwatch\b/);
  expect(controls[0].text).toMatch(/Watch status/i);
  expect(controls[1].cls).toMatch(/\bctl\b/);
  expect(controls[1].text).toMatch(/Notify|Muted/i);
  expect(controls[2].cls).toMatch(/wtwbtn/);
  // The old row is gone: no Pick badge, no bare verdict buttons.
  await expect(first.locator(".actions .pickbtn, .actions .actbtn:not(.wtwbtn)")).toHaveCount(0);

  // The Watch-status chip opens the four CAS-183 answers, and choosing one folds the card to its stub.
  await first.locator(".ctl.watch").click();
  const segs = await page.locator(".cpop .cseg .cl").allTextContents();
  expect(segs.map(s => s.trim())).toEqual(["Don't want", "Disliked", "So-so", "Liked"]);
  // Exact, because "Liked" is a substring of "Disliked" and a loose match hits both.
  const cardId = await first.getAttribute("id");
  await page.locator(".cpop .cseg").filter({ has: page.getByText("Liked", { exact: true }) }).click();
  // What the chip has to achieve is that the answer LANDS — the film joins the watched set that feeds Your
  // Movies (CAS-183). What happens to the row afterwards differs by view and is not this ticket's business:
  // on the All view the card folds to its stub, and on an agent's own listing the agent's exclude-watched rule
  // takes the row out altogether. Asserting the stub here would have been asserting the wrong view's behaviour.
  await expect.poll(() => page.evaluate(() => watched.size), { timeout: 10_000 }).toBe(1);
  await expect(page.locator(`#${cardId} .ctl.watch`)).toHaveCount(0);
});

test("CAS-218 / CAS-222: the card is Blockbusters, the agent is Cinema Blockbusters", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  expect(cards[0].name).toBe("Blockbusters");
  await pickCard(page, "Blockbusters");
  const step = () => page.evaluate(() => onbStepKey);
  for(let i = 0; i < 6 && await step() !== "name"; i++){
    await page.locator("#flowCta:visible, #onbStepCta:visible").first().click();
    await page.waitForTimeout(120);
  }
  expect(await step()).toBe("name");
  const field = page.locator("#onbStepName");
  await expect(field).toHaveValue("Cinema Blockbusters");
  expect(await field.getAttribute("placeholder")).toBe("Cinema Blockbusters");
});

test("CAS-226: the membership price box is the prototype's two-tier panel", async ({ page }) => {
  await toShortlist(page, "cinema");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  const step = () => page.evaluate(() => onbStepKey);
  for(let i = 0; i < 10 && await step() !== "keepfinding"; i++){
    await page.locator("#flowCta:visible, #onbStepCta:visible").first().click();
    await page.waitForTimeout(120);
  }
  expect(await step()).toBe("keepfinding");
  await expect(page.locator(".kfprice .big")).toHaveText("Cascade Membership is free for your first month");
  await expect(page.locator(".kfprice .sub")).toHaveText("then $4.99 / month · cancel any time");
  const styled = await page.evaluate(() => {
    const big = getComputedStyle(document.querySelector(".kfprice .big"));
    const b = getComputedStyle(document.querySelector(".kfprice .sub b"));
    return { size: big.fontSize, weight: big.fontWeight, price: b.color };
  });
  expect(styled.size).toBe("20px");
  expect(styled.weight).toBe("800");
  expect(styled.price).toBe("rgb(201, 190, 255)");
});
