// CAS-231: load the SHIPPED engine, in Node, with no browser.
//
// The engine is not a module — it is the one big classic <script> inside index.html, and it is deliberately so
// (the app is one file you can open from disk). That leaves two ways to unit-test it: extract the engine into
// its own file and change what ships, or evaluate the shipped script as-is against a stand-in DOM. This is the
// second, because the first would mean the tests exercise a copy of the engine rather than the engine.
//
// What makes it work: nothing in the engine's DECISIONS touches the DOM. matchesCriteria, watchCount,
// starterPreview, axisCountsNow and the rest are arithmetic over MOVIES. The DOM appears only in the paint and
// wire code that runs alongside them, and that code does not care whether its writes land anywhere — so a
// permissive stub absorbs it and the arithmetic is the real arithmetic, against the real catalogue that the
// build inlined. If the engine ever starts reading a measurement back and deciding on it, this harness will
// notice: the stub answers 0 for every number, so a decision that depends on layout will visibly change.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every stub node: reads give another stub, calls give another stub, writes are swallowed, and any coercion
// gives 0 or "" instead of throwing.
const node = () => new Proxy(function(){}, {
  get(t, k){
    if(k === "length") return 0;
    if(k === "children") return [];
    if(k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if(k === Symbol.toPrimitive) return hint => (hint === "string" ? "" : 0);
    if(k === "toString") return () => "";
    if(k === "valueOf") return () => 0;
    if(k === "textContent" || k === "innerHTML" || k === "value" || k === "className") return "";
    if(k === "then") return undefined;                    // must never look like a promise
    return node();
  },
  set(){ return true; },
  apply(){ return node(); },
  has(){ return true; },
  deleteProperty(){ return true; },
});

function makeContext(){
  const doc = new Proxy({}, {
    get(t, k){
      if(k === "querySelectorAll" || k === "getElementsByClassName" || k === "getElementsByTagName") return () => [];
      return node();
    },
    set(){ return true; },
  });
  const store = new Map();
  const sessionStore = new Map();
  const ctx = {
    document: doc,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
      clear: () => store.clear(),
      get length(){ return store.size; },
      key: i => [...store.keys()][i] ?? null,
    },
    // CAS-553: the diagnostics panel's `?diag` handling reads/writes sessionStorage at the top level of
    // the engine script (same reasoning as `performance` below, CAS-460) — not browser-only, in reach here.
    sessionStorage: {
      getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: k => { sessionStore.delete(k); },
      clear: () => sessionStore.clear(),
      get length(){ return sessionStore.size; },
      key: i => [...sessionStore.keys()][i] ?? null,
    },
    // Quiet: the engine logs its own analytics line on load, and a test run is not the place for it.
    console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    navigator: { userAgent: "node", language: "en-AU", vibrate(){}, onLine: true },
    location: { href: "http://localhost/", search: "", hash: "", pathname: "/", origin: "http://localhost" },
    history: { replaceState(){}, pushState(){} },
    matchMedia: () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){} }),
    getComputedStyle: () => node(),
    CSS: { escape: s => String(s) },
    URLSearchParams, URL, TextEncoder, TextDecoder, structuredClone, crypto,
    CustomEvent: class { constructor(type, opts){ this.type = type; Object.assign(this, opts || {}); } },
    Event: class { constructor(type){ this.type = type; } },
    MutationObserver: class { observe(){} disconnect(){} takeRecords(){ return []; } },
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    ResizeObserver: class { observe(){} unobserve(){} disconnect(){} },
    Image: class { set src(v){} },
    performance,
    addEventListener(){}, removeEventListener(){}, dispatchEvent(){ return true; },
    fetch: () => Promise.reject(new Error("the engine must not need the network")),
    alert(){}, scrollTo(){}, scrollBy(){}, open(){ return null; },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2, scrollY: 0,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx;
  return ctx;
}

// The engine's top-level `const`/`let` are lexical, exactly as in a browser, so they are not properties of the
// global. Appending the export block INSIDE the same script is what puts them in reach — the same scope the
// engine's own code reads them from, so a test can never accidentally be handed a copy.
// Mutable bindings (flowKind, onbFlow's fields) are exposed through getters so a test always sees live state.
const EXPORTS = `
// CAS-667: window.CascadeAuth is normally set up by the auth module script (a separate <script type="module">
// this harness deliberately does not load, per the file-level comment above — the engine itself never needs
// it directly, only through window.CascadePersistence.accountActive()). Seed the same shape that module sets
// on a guest device so accountActive() has something real to read, and a test can flip it to simulate sign-in.
if(typeof window.CascadeAuth === "undefined"){
  window.CascadeAuth = { enabled:false, client:null, user:null, session:null, status:"guest" };
}
;globalThis.__ENGINE__ = {
  MOVIES, CASCADE, STATUS_LABEL, SHOWABLE_N,
  matchesCriteria, countCriteria, watchCount, watchesFilm, matchesTaste, listedBy, listWindowOK,
  listedCount, onbShownCount,
  // CAS-723: inScope is the predicate the "one agent type" invariant is actually about — exported so a test
  // can assert it directly rather than re-deriving it from watchesFilm's combination with matchesTaste.
  inScope,
  // CAS-680: the list-editor's own predicates — ymFeedList (the list's own total, no inFindScope applied),
  // ymAgentListCount (an agent's contribution TO the active list), inFindScope and scope (the scope bar
  // that scopeRows() applies and ymFeedList() deliberately does not) — so a test can assert the two
  // predicates stay different rather than re-deriving them from render() output. YM_SVC/ymSvcOn/ymSvcToggle
  // let a test drive the availability chips the same way a person taps them.
  ymFeedList, ymAgentListCount, inFindScope, scope, scopeRows,
  // CAS-682: taggedOut — the predicate that decides card vs. stub — so a test can assert a stub is really
  // a stub, rather than assuming a watched film demonstrates it.
  // CAS-718: opinionOf alongside it — the verdict key a taggedOut film carries, which watchWatchedSel below
  // is keyed by.
  taggedOut, opinionOf,
  // CAS-718: the Filters sheet's own per-tab state (watchTab/watchWatchedSel/watchGenreOff/watchSearch) and
  // the predicate render() filters through (filmMatchesWatchedFilter) — exported the same way watchGenreOff
  // et al. would be, so a test can drive a tab's Watched/Styles selection directly rather than only through
  // DOM clicks the stub absorbs.
  get watchTab(){ return watchTab; },
  watchWatchedSel, watchGenreOff, watchSearch, filmMatchesWatchedFilter, filmMatchesWatchTab,
  YM_SVC,
  // CAS-677: WATCH_STEPS (the watched-verdict ramp watchlistDefaults()'s permissive watchedOn is built
  // from), ymWatchedOn itself (by reference, like ymCascOff below, so a test can drive it directly the same
  // way a restrictive pre-ticket value would have) and leInnerHTML (the list editor's real render, so a
  // test can assert the removed verdict section is actually gone from its output, not just from source text).
  // CAS-693: leComputeCounts is the single-pass replacement for the old ymFeedList()+per-agent
  // ymAgentListCount(c) calls leInnerHTML used to make — exported so a test can assert the two ways of
  // computing the same figures still agree, without parsing leInnerHTML()'s HTML output for numbers.
  WATCH_STEPS, leInnerHTML, leComputeCounts,
  get ymWatchedOn(){ return ymWatchedOn; },
  get ymSvcOn(){ return ymSvcOn; },
  ymSvcToggle: (key, btn) => window.ymSvcToggle(key, btn),
  ymSvcSetAll: on => window.ymSvcSetAll(on),
  normCascade, showable, primaryStatus, inCinemaWindow, isEstimated, deriveStatus, isUpcoming,
  // CAS-255: the my-services scope and the stage dates are both places the app makes a claim about what you
  // can watch and when, so the QA gate needs to reach them the same way the listing does.
  prefs, servicesPicked, matchesServices, scopeOf, anyScope, HOME_KEYS,
  svcCanon, svcName, SVC_LEAD, myService,
  SUB_SERVICES, STORE_SERVICES, stageDate, curSlot, cinemaState, EST_OFFSET, TODAY,
  inCinemaRun, CINEMA_RUN_DAYS, LISTING_ORDER, CINEMA_LISTING_ORDER, orderFor, listingOrder,
  // CAS-702: the one default-sort constant, and the raw comparator dispatch, so a test can assert the
  // rendered order against an independently-run comparator rather than re-deriving sortForKey's branches.
  DEFAULT_SORT, sortForKey,
  fmtDay, fmtDate, bandHTML, windowsLineHTML, savingsHTML,
  inferredScale, inferScaleWhy, budgetCell, moneyRowHTML, SCALE_INFER_MIN_PEERS, popOf, scaleTier,
  agentWindow, winOn, subOn, winSubs, PRIORITY_WATCH, ALERT_DEFAULTS, ALERT_SHORT, ALERT_MOMENT,
  alertLive, reachableRows, liveAlerts, drawWatchLanes,
  selScaleMatch, selCrowdOK, selCriticsOK, selBuzzOK, voteReadout, critScoreReadout, scaleReadout,
  // CAS-694: critScore (the one recorded critics figure) and qScore's own text (qScoreSourcesText), so a test
  // can assert both independently rather than re-deriving them from qScore's output alone.
  qScore, critScore, qScoreSourcesText, sortMoviesBy, ratingOf, IMDB_MIN_VOTES, imdbReliable,
  // CAS-695: the Cascade score's own basis switch (cascadeScore/cascadeScoreSourcesText, dispatching on
  // isPreRelease) and the cinema-side score it dispatches to (cinemaScore, over buzzPctlOf and its sorted
  // cohort array/rank lookup) — exported independently so a test can assert each stage rather than only the
  // combined qScoreHTML output. CAS-722 retired budgetPctlOf itself (budget left the score); CINEMA_BUDGET_VALS/
  // CINEMA_BUDGET_MIN survive — CAS-724's legacyMissionFloorDefault still reads them for a cinema agent's
  // one-time scoreFloor migration.
  cascadeScore, cascadeScoreSourcesText, cinemaScore, isPreRelease, buzzPctlOf, pctRankOf,
  BUZZ_POP_VALS, CINEMA_BUDGET_VALS, CINEMA_BUDGET_MIN,
  // CAS-703: the Target score hard gate's own held-back count, so a test can assert it against the set it
  // claims to describe without re-deriving it from stepCountLine's HTML output.
  scoreHeldBackCount,
  // CAS-686: the per-film predicate that decides which condensed-card stats row shows (r-scores vs
  // r-cinfo), so a test can assert the row choice directly rather than re-deriving the three-source rule.
  condensedShowsScores,
  SCALE_REF, BUZZ_STOPS, VOTE_REF, CRIT_MARKS, AWARD_STOPS, awardRank, parseAwards,
  // CAS-678: the one popularity ladder — its cohort gate, its cuts, the per-film stop it computes, and
  // Landmark's own (unchanged) predicate, so a test can assert the badge/dial/cohort/Landmark relationships
  // directly rather than re-deriving them from scaleTier() alone.
  isLandmark, inLadderCohort, buzzStop, buzzBandOf, BUZZ_CUTS, BUZZ_PCTL, BUZZ_KEY,
  AGE_LEVELS, ONB_GENRES, LANG_OPTS, GENRE_COUNT,
  YEARS_STOPS, YEARS_STOP_POS, yearsForPos, posForYears, yearsCutoff, releasedSince,
  yearsFromLegacy, yearsLabel, yearsReadout, flowYearsBack, baseYearsBack, yearOf,
  MIN_INITIAL_MATCHES, autoRelaxBar, barDialSnapshot,
  STARTERS, startersFor, starterPreview, starterCount, starterAgentName, starterWatch, RECOMMENDED_FOR,
  AGENT_WINDOWS, agentWindows, watchToStatuses, listToStatuses, migrateWatch,
  MISSION_DIALS, MISSION_DIALS_USED, missionRest, missionKind, laneCrit,
  axisCountsNow, genreCountsNow,
  onbApply, onbCount, pickStarter, flowStart, flowPriority, flowStop, FLOWS,
  tasteBase, cascades,
  get onbFlow(){ return onbFlow; },
  get flowKind(){ return flowKind; },
  setFlowKind(k){ flowKind = k; },
  // CAS-666: the watch-list scratch-state bridge (deckSelect/wlRailCreate are wire code, exercised here the
  // same way the rest of this file's "wire code" comment describes — DOM reads/writes are absorbed by the stub).
  watchLists, activeWatchlist, setActiveWatchlist, applyActiveWatchlist, watchlistRecord,
  normWatchlistEntry, watchlistDefaults, deckSelect, wlRailCreate,
  get watchActiveId(){ return watchActiveId; },
  // CAS-673: activeCascades/activeIds are what the live listing (scopeRows) and the empty state
  // (emptyResultsHTML) both read; ymCascOff/ymCascTicked are the list editor's own live scratch Set for
  // agent membership, and ymCascToggle/ymCascSetAll (window-assigned wire code, wrapped the same way
  // renderMovingScreen is above) are its two write sites — the ones the ordering bug was in.
  activeCascades, emptyResultsHTML,
  get activeIds(){ return activeIds; },
  get ymCascOff(){ return ymCascOff; },
  ymCascTicked,
  ymCascToggle: (id, btn) => window.ymCascToggle(id, btn),
  ymCascSetAll: on => window.ymCascSetAll(on),
  // CAS-676: the Edit screen's own open/close (wire code, DOM absorbed by the stub, same pattern as
  // openMovingScreen/closeMovingScreen below) plus its open flag and its "the deck still owes a rebuild"
  // flag, so a test can drive a burst of toggles while it's open and assert what got deferred to close.
  leOpen: () => window.leOpen(),
  leClose: () => window.leClose(),
  get leOn(){ return leOn; },
  get ymDeckStale(){ return ymDeckStale; },
  // CAS-667: movingData is wire-adjacent (it reads window.CascadePersistence.accountActive()) but its
  // row-selection arithmetic is exactly the kind of decision this harness exists to test. realAlerts and
  // firstFound are exposed by reference (mutated via push, never reassigned, in test use) so a test can seed
  // the ledger; CascadeAuth is exposed the same way so a test can flip a device between guest and signed-in
  // by setting .enabled/.client/.session, exactly as the real sign-in path does.
  movingData, realAlerts, firstFound, watched,
  get movingReady(){ return movingReady; },
  setMovingReady(v){ movingReady = v; },
  get CascadeAuth(){ return window.CascadeAuth; },
  // CAS-670: movingData/renderMovingScreen's guest branch now keys off localStorage's cascade_had_account,
  // not accountActive() — exposing the stub localStorage (already the engine's own global) lets a test drive
  // that key directly instead of only being able to flip the (now branch-irrelevant) CascadeAuth fields.
  localStorage,
  // CAS-668: the badge/list agreement — movingWindowRows is the one recipe both renderMovingScreen and
  // movingUnseenCount filter through, movingBadgeWindow is which window applies right now (live if Moving
  // is open, predicted if it's not), and openMovingScreen/closeMovingScreen/setMovingWindow are the
  // real wire code (DOM reads/writes absorbed by the stub, exactly like the rest of this file's wire calls).
  movingWindowRows, movingUnseenCount, movingBadgeWindow, movingAutoOpenWindow, movingInWindow,
  MOVING_WINDOWS, movingSeen,
  // CAS-670 AC2/AC4: renderMovingScreen is wire code (its DOM write is absorbed by the stub) but its early
  // return on the loading-state guard is a real decision — whether it marks any row seen — so a test needs
  // to call the real function rather than re-deriving the guard.
  renderMovingScreen: () => window.renderMovingScreen(),
  get movingWindow(){ return movingWindow; },
  get movingIsOpen(){ return movingIsOpen; },
  openMovingScreen: () => window.openMovingScreen(),
  closeMovingScreen: () => window.closeMovingScreen(),
  setMovingWindow: (key) => window.setMovingWindow(key),
  // CAS-662: the listing's own group partition — pure over a rows set and an active agent, no DOM, so it is
  // exactly the "decision" half of render() this harness exists to test independent of the paint half.
  // CAS-699: ymSort exposed by getter/setter (like watchPrefs/flowKind below) so a test can drive the list's
  // own sort pick the same way ymSortChange does, and assert listingGroups honours it over CAS-430's default.
  listingGroups,
  get ymSort(){ return ymSort; },
  setYmSort(v){ ymSort = v; },
  // CAS-613: auto-notify's own decision surface. recomputeFound is the wire-adjacent entry point (it reads
  // cascades/MOVIES and writes notify), exposed the same way movingData is above; notify/entryFor let a test
  // seed and read the per-film arming state directly; watchPrefs is exposed through a getter/setter (like
  // flowKind) because the engine REASSIGNS the binding wholesale on load/sync, not just its contents.
  recomputeFound, notify, entryFor, watchLevelsFor, WATCH_LEVEL_KEYS,
  // CAS-728: cascSigOf/agentFloor are what recomputeFound's own sticky-admission re-evaluation reads to
  // decide whether an agent has changed and what its current floor is — exported so a test can compute the
  // exact signature/floor a seeded agent_films row should carry, rather than guessing at internal state.
  cascSigOf, agentFloor,
  // CAS-726: filmWatchSource is the provenance read the round-trip test asserts against directly;
  // toggleFilmOpt is wire code (window-assigned, like ymCascToggle above) — a test drives a manual
  // tick through the real function rather than poking notify[id].wins by hand.
  filmWatchSource,
  toggleFilmOpt: (id, key) => window.toggleFilmOpt(id, key),
  get watchPrefs(){ return watchPrefs; },
  setWatchPrefs(w){ watchPrefs = w; },
  // CAS-602: the bell's own moment-copy lookup, so a test can assert a monitor moment key can never
  // render as its raw string (see REAL_MOMENT_SAID's own use at the ntfrow render site).
  REAL_MOMENT_SAID,
  // CAS-674: the Agents row's own metrics compute, so a test can check its "total" agrees with the
  // listing (listedCount) rather than the wider watch-ahead set (watchesFilm) it used to read.
  agentMetricsCompute,
  // CAS-681: the account-persistence seam (load/sync/reconcile for cascades/films/lists/watchlists/etc,
  // CAS-212's pendingMerge, CAS-408's reconcile family) lives on window.CascadePersistence, assigned once
  // at the bottom of the account-sync IIFE — a live reference, so a test can stub CascadeAuth.client with
  // a fake Supabase and call e.g. CascadePersistence.loadWatchlistAccount() directly.
  get CascadePersistence(){ return window.CascadePersistence; },
};
`;

/** Read index.html, take its ONE classic engine script, and evaluate it against the stub DOM. */
export function loadEngine({ htmlPath = path.join(ROOT, "index.html") } = {}){
  const html = fs.readFileSync(htmlPath, "utf8");
  const open = html.indexOf("<script>");
  if(open < 0) throw new Error(`no classic <script> found in ${htmlPath}`);
  const close = html.indexOf("</script>", open);
  if(close < 0) throw new Error(`unterminated <script> in ${htmlPath}`);
  const src = html.slice(open + "<script>".length, close);
  // A truncated or reshaped build would silently give us a tiny "engine" that passes everything, so refuse
  // anything that obviously isn't it.
  if(src.length < 200000) throw new Error(`engine script is only ${src.length} chars — is this a real build?`);

  const ctx = makeContext();
  const sandbox = vm.createContext(ctx);
  vm.runInContext(src + EXPORTS, sandbox, { filename: `${path.basename(htmlPath)}#engine`, timeout: 120000 });
  const api = ctx.__ENGINE__;
  if(!api) throw new Error("engine loaded but exported nothing");
  for(const [k, v] of Object.entries(api)) if(v === undefined) throw new Error(`engine export "${k}" is undefined`);
  return api;
}

/** A fresh flow, seeded exactly the way a person walking the app seeds it. */
export function pickInLane(E, kind, presetKey){
  E.flowStart();
  E.flowPriority(kind);
  E.pickStarter(presetKey);
  return E;
}
