// CAS-908: re-runnable check for the v2 onboarding answers model and four-agent generator
// (onbAnswersV2Default/ONB_AGENTS_V2/buildOnbAgentsV2/onbFavsSolve), driving criteria 4-11 against
// the real built index.html the same way tests/js/engine.mjs does — a classic <script> evaluated
// in a stub-DOM vm context — but written as its own file, not a change under tests/, per this
// ticket's own AC2 (nothing under tests/ moves for a ticket that adds no test-visible behaviour).
// Sibling to qa-agents-report.txt (CAS-794): writes qa-onboarding-v2-report.txt at the repo root,
// PASS/FAIL per check, same format, never committed (see .gitignore).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.join(ROOT, "qa-onboarding-v2-report.txt");

// Same stub shape as tests/js/engine.mjs's makeContext — every stub node: reads give another stub,
// calls give another stub, writes are swallowed, coercion gives 0/"" instead of throwing. Kept here
// rather than imported so this file makes no change under tests/.
const node = () => new Proxy(function(){}, {
  get(t, k){
    if(k === "length") return 0;
    if(k === "children") return [];
    if(k === Symbol.iterator) return [][Symbol.iterator].bind([]);
    if(k === Symbol.toPrimitive) return hint => (hint === "string" ? "" : 0);
    if(k === "toString") return () => "";
    if(k === "valueOf") return () => 0;
    if(k === "textContent" || k === "innerHTML" || k === "value" || k === "className") return "";
    if(k === "then") return undefined;
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
    sessionStorage: {
      getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: k => { sessionStore.delete(k); },
      clear: () => sessionStore.clear(),
      get length(){ return sessionStore.size; },
      key: i => [...sessionStore.keys()][i] ?? null,
    },
    console: { log(){}, warn(){}, error(){}, info(){}, debug(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    navigator: { userAgent: "node", language: "en-AU", vibrate(){}, onLine: true },
    screen: { orientation: { type: "portrait-primary" } },
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
    alert(){}, confirm(){ return true; }, scrollTo(){}, scrollBy(){}, open(){ return null; },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2, scrollY: 0,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx;
  return ctx;
}

// Only the v2 onboarding surface this file's checks actually call — everything else the real
// engine needs stays reachable to IT (lexical scope inside the evaluated script), just not handed
// out to this file.
const EXPORTS = `
;globalThis.__ONB_V2__ = { onbAnswersV2Default, ONB_AGENTS_V2, buildOnbAgentsV2, onbFavsSolve, onbNotifySum,
  MOVIES, watchesFilm };
`;

function loadOnbV2({ htmlPath = path.join(ROOT, "index.html") } = {}){
  const html = fs.readFileSync(htmlPath, "utf8");
  const open = html.indexOf("<script>");
  const close = html.indexOf("</script>", open);
  if(open < 0 || close < 0) throw new Error(`no classic <script> found in ${htmlPath}`);
  const src = html.slice(open + "<script>".length, close);
  if(src.length < 200000) throw new Error(`engine script is only ${src.length} chars — is this a real build?`);
  const ctx = makeContext();
  const sandbox = vm.createContext(ctx);
  vm.runInContext(src + EXPORTS, sandbox, { filename: `${path.basename(htmlPath)}#engine`, timeout: 120000 });
  const api = ctx.__ONB_V2__;
  if(!api) throw new Error("engine loaded but exported nothing");
  for(const [k, v] of Object.entries(api)) if(v === undefined) throw new Error(`export "${k}" is undefined`);
  return api;
}

const E = loadOnbV2();

fs.writeFileSync(REPORT_PATH, "");
const results = [];
function check(id, fn){
  try{ fn(); results.push(`PASS ${id}`); }
  catch(e){ results.push(`FAIL ${id} - ${String(e.message ?? e).split("\n")[0]}`); }
}
// Values returned across the vm boundary are instances of the SANDBOX's own Array/Object, so
// assert.deepEqual's cross-realm identity check rejects them even when structurally identical —
// compare via a JSON round-trip instead, which is exact for this plain, cycle-free, function-free
// data (watchMarkers/genre/order/name).
const same = (actual, expected, msg) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

const BASE_A = { cinema:"yes", rent:"no", styles:[], selScale:0, ages:["M","MA 15+"],
                 partner:"no", kids:"no" };
const BASE_B = { ...BASE_A, partner:"yes", partnerDiff:"no", kids:"yes", kidAges:["G","PG"] };

check("AC4", () => {
  const agents = E.buildOnbAgentsV2(BASE_A);
  assert.equal(agents.length, 2);
  same([...agents].map(a => a.name), ["Massive Movies", "Personal Favs"]);
  assert.equal(agents[0].order, 0);
  assert.equal(agents[1].order, 1);
});

check("AC5", () => {
  const agents = E.buildOnbAgentsV2(BASE_B);
  same([...agents].map(a => a.name),
    ["Massive Movies", "Personal Favs", "Date Night", "Family Movies"]);
});

check("AC6", () => {
  const m1 = [...E.buildOnbAgentsV2({ ...BASE_A, cinema:"yes" })].find(a => a.name === "Massive Movies");
  same(m1.watchMarkers, { in_cinema:90, premium:null, rent:null, stream:null });
  const m2 = [...E.buildOnbAgentsV2({ ...BASE_A, cinema:"no", rent:"yes" })].find(a => a.name === "Massive Movies");
  same(m2.watchMarkers, { in_cinema:null, premium:null, rent:90, stream:null });
  const m3 = [...E.buildOnbAgentsV2({ ...BASE_A, cinema:"no", rent:"no" })].find(a => a.name === "Massive Movies");
  same(m3.watchMarkers, { in_cinema:null, premium:null, rent:null, stream:90 });
});

check("AC7", () => {
  const yes = E.buildOnbAgentsV2({ ...BASE_A, cinema:"yes" }).find(a => a.name === "Massive Movies");
  assert.equal(yes.watchWindows.upcoming.notify, true);
  const no = E.buildOnbAgentsV2({ ...BASE_A, cinema:"no" }).find(a => a.name === "Massive Movies");
  assert.notEqual(no.watchWindows.upcoming.notify, true);
});

check("AC8", () => {
  const fam = [...E.buildOnbAgentsV2(BASE_B)].find(a => a.name === "Family Movies");
  same(fam.genre, []);
  assert.notEqual(fam.genre, null);
});

check("AC9", () => {
  for(const ans of [BASE_A, BASE_B]){
    for(const a of E.buildOnbAgentsV2(ans)){
      assert.equal(a.budget, 0, `${a.name} budget`);
      assert.equal(typeof a.selScale, "number", `${a.name} selScale`);
    }
  }
});

check("AC10", () => {
  for(const ans of [BASE_A, BASE_B]){
    const s = E.onbFavsSolve(ans);
    assert.ok(Number.isInteger(s) && s >= 60 && s <= 90, `onbFavsSolve(${JSON.stringify(ans)}) = ${s}`);
    const favs = E.buildOnbAgentsV2(ans).find(a => a.name === "Personal Favs");
    const nonNull = Object.values(favs.watchMarkers).filter(v => v != null);
    assert.equal(Math.max(...nonNull), s);
  }
});

check("AC11", () => {
  for(const ans of [BASE_A, BASE_B]){
    for(const a of E.buildOnbAgentsV2(ans)){
      assert.ok(!("onbCap" in a) || a.onbCap === undefined, `${a.name} carries onbCap`);
    }
  }
});

// CAS-912: onb_favs must ring on its BIG window only — the trailing windows still admit and list
// films but do not notify. Massive Movies/Date Night/Family Movies are explicitly untouched.
check("CAS912-AC2", () => {
  const favs = E.buildOnbAgentsV2(BASE_A).find(a => a.name === "Personal Favs");
  const notifying = Object.entries(favs.watchWindows).filter(([, w]) => w.notify).map(([k]) => k);
  same(notifying, ["in_cinema"]);
});

check("CAS912-AC3", () => {
  const rentFavs = E.buildOnbAgentsV2({ ...BASE_A, cinema:"no", rent:"yes" }).find(a => a.name === "Personal Favs");
  same(Object.entries(rentFavs.watchWindows).filter(([, w]) => w.notify).map(([k]) => k), ["rent"]);
  const streamFavs = E.buildOnbAgentsV2({ ...BASE_A, cinema:"no", rent:"no" }).find(a => a.name === "Personal Favs");
  same(Object.entries(streamFavs.watchWindows).filter(([, w]) => w.notify).map(([k]) => k), ["stream"]);
});

check("CAS912-AC4", () => {
  for(const ans of [BASE_A, { ...BASE_A, cinema:"no", rent:"yes" }, { ...BASE_A, cinema:"no", rent:"no" }]){
    const favs = E.buildOnbAgentsV2(ans).find(a => a.name === "Personal Favs");
    for(const [k, marker] of Object.entries(favs.watchMarkers)){
      if(marker == null) continue;
      assert.equal(favs.watchWindows[k].list, true, `${k} not listed for answers ${JSON.stringify(ans)}`);
    }
  }
});

check("CAS912-AC5", () => {
  const agents = E.buildOnbAgentsV2(BASE_B);
  same(agents.find(a => a.name === "Massive Movies").watchWindows,
    { in_cinema:{list:true, notify:true}, upcoming:{list:true, notify:true, subs:{announced:true, opens_soon:true}} });
  same(agents.find(a => a.name === "Date Night").watchWindows,
    { rent:{list:true, notify:false}, stream:{list:true, notify:true} });
  same(agents.find(a => a.name === "Family Movies").watchWindows,
    { in_cinema:{list:true, notify:false}, rent:{list:true, notify:false}, stream:{list:true, notify:true} });
});

check("CAS912-AC6", () => {
  const favs = E.buildOnbAgentsV2(BASE_A).find(a => a.name === "Personal Favs");
  assert.equal(E.onbNotifySum(favs), "When it hits in cinema");
});

// CAS-915: Massive Movies becomes an adult-blockbuster agent (age-capped, unrated admitted so the
// upcoming/opening_week titles it exists for don't vanish — see the ticket's own trap warning).
check("CAS915-AC2", () => {
  for(const ans of [BASE_A, BASE_B]){
    const m = E.buildOnbAgentsV2(ans).find(a => a.name === "Massive Movies");
    same(m.age, ["M","MA 15+","R 18+"]);
    assert.equal(m.includeUnrated, true);
  }
});

check("CAS915-AC3", () => {
  for(const ans of [BASE_A, BASE_B]){
    const m = E.buildOnbAgentsV2(ans).find(a => a.name === "Massive Movies");
    const films = E.MOVIES.filter(f => E.watchesFilm(f, m));
    assert.ok(films.every(f => f.age_rating !== "G" && f.age_rating !== "PG"),
      "Massive Movies film list contains a G/PG title");
  }
});

check("CAS915-AC4", () => {
  for(const ans of [BASE_A, BASE_B]){
    const m = E.buildOnbAgentsV2(ans).find(a => a.name === "Massive Movies");
    const films = E.MOVIES.filter(f => E.watchesFilm(f, m));
    assert.ok(films.length > 0, "Massive Movies film list is empty");
    assert.ok(films.some(f => f.status.includes("upcoming")), "Massive Movies has no upcoming film");
  }
});

check("CAS915-AC5", () => {
  const favsA = E.buildOnbAgentsV2(BASE_A).find(a => a.name === "Personal Favs");
  same(favsA.age, BASE_A.ages);
  const famB = E.buildOnbAgentsV2(BASE_B).find(a => a.name === "Family Movies");
  same(famB.age, BASE_B.kidAges);
});

for(const line of results) fs.appendFileSync(REPORT_PATH, line + "\n");
const pass = results.filter(l => l.startsWith("PASS ")).length;
const fail = results.filter(l => l.startsWith("FAIL ")).length;
const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
fs.appendFileSync(REPORT_PATH, `\nTOTAL ${results.length} PASS ${pass} FAIL ${fail}\nCOMMIT ${sha}\n`);

for(const line of results) console.log(line);
console.log(`\nTOTAL ${results.length} PASS ${pass} FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
