// CAS-529: "Your Movies" — a live, filterable "what can I watch now" feed replaces the old static screen
// as the primary view. Match rule (Lee's own words): a film qualifies if it sits in at least one TICKED
// cascade AND its own Watch it ticks cover at least one TICKED service. Default: Streaming only, every
// cascade ticked, rewatch off. The old three-bucket "Movie selections" list stays put, unchanged, below it.
import { test, expect } from "@playwright/test";
import { toShortlist, shortlistCards, pickCard, finishFlow, toListing, settleListing } from "./helpers.mjs";

/** Build a stream-kind cascade with real matching films, land on its listing. */
async function toStreamListing(page){
  await toShortlist(page, "stream");
  const cards = await shortlistCards(page);
  await pickCard(page, cards[0].name);
  await finishFlow(page);
  await toListing(page);
  await settleListing(page);
}

/** The tmdb id of the first full (non-stub) card on the listing behind it. */
async function firstCardId(page){
  const card = page.locator("#groups .card").first();
  await expect(card).toBeVisible();
  const domId = await card.getAttribute("id");
  return Number(domId.replace("card-", ""));
}

/** Tick a Watch-it level (data-wk) on a specific card via the real chip + popover row, like a person would.
 * Ticking a level leaves the panel open (only answering a verdict closes it), so a second call on the same
 * card must not re-tap the chip — that's the real app's own toggle, and it would close the panel it just
 * left open instead of reusing it. */
async function tickWatchIt(page, id, wk){
  const chip = page.locator(`#card-${id} .ctl.notify`);
  if(!/(^| )open( |$)/.test(await chip.getAttribute("class") || "")) await chip.click();
  await page.locator(`#card-${id} .cpop.npop .nopt[data-wk="${wk}"]`).click();
}

/** Set a verdict (wow/liked/enjoyed/soso/disliked) on a card via its Watched chip's real popover. */
async function pickVerdict(page, id, key){
  // A tap anywhere on the card while a DIFFERENT control's popover is open just closes that popover — same
  // rule cas500.spec.mjs works around at its own control switch — so a panel left open by an earlier helper
  // (e.g. tickWatchIt's notify popover) must be dismissed first or this click never reaches .ctl.watch at all.
  await page.keyboard.press("Escape");
  await page.locator(`#card-${id} .ctl.watch`).click();
  await page.locator(`.cpop .cseg[data-key="${key}"]`).click();
}

/** "Never" (CAS-349) isn't one of the Watched popover's csegs — it moved to the Notify panel's own
 * data-wk="never" row (pickNever), so it needs the tickWatchIt path, not pickVerdict's .cseg click. */
async function pickNever(page, id){
  await tickWatchIt(page, id, "never");
}

function openYourMovies(page){ return page.evaluate(() => window.openYourMovies()); }

// CAS-535: the services/cascades/rewatch controls moved behind the compact card's own Edit button — every
// test below that reads or taps them needs the panel open first.
async function openYmEdit(page){
  await page.locator(".ymcedit").click();
  await expect(page.locator(".ympanel")).toBeVisible();
}

// CAS-536: the service filter now requires the film to actually be AT the ticked window (m.status), not
// merely to have ticked it — a tick can be set ahead of time on a future rung (CAS-473) or cascade onto
// every rung below the one just tapped (CAS-349), neither of which means "available via this service now".
// Tests below that need a film to positively match a service filter have to tick + filter on the film's
// REAL current window rather than a hardcoded one.
const SVC_LABEL = {in_cinema:"Cinema", premium:"Buy", rent:"Rent", stream:"Streaming"};
async function currentSvcKey(page, id){
  return page.evaluate((id) => {
    const m = MOVIES.find(x => x.tmdb_id === id);
    if(!m) return null;
    for(const w of m.status){
      const key = filmOptKeyForWindow(null, w);
      if(WATCH_LEVEL_KEYS.includes(key)) return key;
    }
    return null;
  }, id);
}
/** Ticks every YM service chip OFF except `label` — the Edit panel must already be open. */
async function selectOnlyService(page, label){
  for(const l of ["Cinema","Streaming","Rent","Buy"]){
    const chip = page.locator(".ymchip", { hasText: l });
    const isOn = /(^| )on( |$)/.test(await chip.getAttribute("class") || "");
    if((l===label) !== isOn) await chip.click();
  }
}

test("CAS-529: opens on the feed with its default filters — Streaming only, every cascade ticked, rewatch off", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);

  await expect(page.locator("#yourMovies.open")).toBeVisible();
  await expect(page.locator(".ympanel")).toHaveCount(0);   // CAS-535: collapsed behind Edit by default
  await openYmEdit(page);

  const streamChip = page.locator(".ymchip", { hasText: "Streaming" });
  await expect(streamChip).toHaveClass(/on/);
  for(const label of ["Cinema", "Rent", "Buy"]){
    await expect(page.locator(".ymchip", { hasText: label })).not.toHaveClass(/on/);
  }

  await expect(page.locator(".agrow.ym-casc")).toHaveCount(1);
  await expect(page.locator(".ymcasctgl")).toHaveClass(/on/);
  await expect(page.locator(".ymcaschead")).toHaveText(/1 of 1/);

  await expect(page.locator(".ymrewatchrow .tgl")).not.toHaveClass(/on/);
});

test("CAS-529: match rule needs the film's OWN Watch it tick on a ticked service, not just any ticked service", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  const svc = await currentSvcKey(page, id);
  test.skip(svc === null, "picked card isn't at any Watch-ladder window right now");
  const label = SVC_LABEL[svc];
  await tickWatchIt(page, id, svc);   // this film says its own CURRENT window — nothing else

  await openYourMovies(page);
  await openYmEdit(page);
  await selectOnlyService(page, label);
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();

  // Switch the FILTER to a different service — a service being ticked on the filter is not enough if the
  // film itself never said that one.
  const otherLabel = label === "Cinema" ? "Streaming" : "Cinema";
  await selectOnlyService(page, otherLabel);
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  await expect(page.locator(".unone", { hasText: "No films match" })).toBeVisible();

  // Switching back brings it straight back.
  await selectOnlyService(page, label);
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();
});

test("CAS-529: match rule needs at least one TICKED cascade to list the film, even with the service ticked", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  const svc = await currentSvcKey(page, id);
  test.skip(svc === null, "picked card isn't at any Watch-ladder window right now");
  await tickWatchIt(page, id, svc);

  await openYourMovies(page);
  await openYmEdit(page);
  await selectOnlyService(page, SVC_LABEL[svc]);
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();

  await page.locator(".ymcasctgl").click();   // the only cascade — untick it
  await expect(page.locator(".ymcasctgl")).not.toHaveClass(/on/);
  await expect(page.locator(".ymcaschead")).toHaveText(/0 of 1/);
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  await expect(page.locator(".unone", { hasText: "No films match" })).toBeVisible();

  await page.locator(".ymcasctgl").click();   // tick it back
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();
});

test("CAS-529: rewatch toggle — a Watched film is excluded by default and reappears (with the incl. wording) once it's on", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  const svc = await currentSvcKey(page, id);
  test.skip(svc === null, "picked card isn't at any Watch-ladder window right now");
  await tickWatchIt(page, id, svc);
  await pickVerdict(page, id, "wow");   // folds the card to a stub on the listing behind — expected

  await openYourMovies(page);
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
  await expect(page.locator(".ymresultbar")).toHaveText(/0 films/);
  await openYmEdit(page);
  await selectOnlyService(page, SVC_LABEL[svc]);

  await page.locator(".ymrewatchrow .tgl").click();
  await expect(page.locator(".ymrewatchrow .tgl")).toHaveClass(/on/);
  await expect(page.locator(`#ymCards #card-${id}`)).toBeVisible();
  await expect(page.locator(".ymresultbar")).toHaveText(/incl\. 1 you've already watched/);
});

test("CAS-529: a film marked Never stays excluded even with rewatch on", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  await tickWatchIt(page, id, "stream");
  await pickNever(page, id);

  await openYourMovies(page);
  await openYmEdit(page);
  await page.locator(".ymrewatchrow .tgl").click();
  await expect(page.locator(`#ymCards #card-${id}`)).toHaveCount(0);
});

test("CAS-529: the reused card component's own Watch it control works live from inside the feed", async ({ page }) => {
  await toStreamListing(page);
  const id = await firstCardId(page);
  const svc = await currentSvcKey(page, id);
  test.skip(svc === null, "picked card isn't at any Watch-ladder window right now");
  await tickWatchIt(page, id, svc);

  await openYourMovies(page);
  await openYmEdit(page);
  await selectOnlyService(page, SVC_LABEL[svc]);
  const chip = page.locator(`#ymCards #card-${id} .ctl.notify`);
  // The "on"/glow class tracks whether the ticked level is CURRENT (filmNotifyState's st.current), not
  // merely ticked — aria-pressed is the one that reflects "a level is ticked at all" (st.on), so that's
  // the live-state check that belongs to this feed, not the card component's own currency styling.
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(chip).toContainText("Watch it");
  await expect(page.locator(`#ymCards #card-${id} .ctl.watch`)).toBeVisible();
  await expect(page.locator(`#ymCards #card-${id} .ctl.casc`)).toBeVisible();   // Lists control, present too
});

test("CAS-529: the old three-bucket Movie selections list stays put, unchanged, below the new feed", async ({ page }) => {
  await toStreamListing(page);
  await openYourMovies(page);

  const sec = page.locator(".usec", { hasText: "Movie selections" });
  await expect(sec).toBeVisible();
  const groupLabels = await page.locator(".ucard .urow .ut").allTextContents();
  expect(groupLabels.some(t => /Unwatched/.test(t))).toBe(true);
  expect(groupLabels.some(t => /Watched/.test(t))).toBe(true);
  expect(groupLabels.some(t => /Don't want to watch/.test(t))).toBe(true);
});
