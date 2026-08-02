# Cascade — onboarding & selectivity redesign · BUILD SPEC (locked 2026-07-23)

Reference implementation (the visual + interaction source of truth): **`onboarding-mocks/r5-prototype.html`** (present in this repo) — a working, self-contained click-through of the whole flow. Build the real thing to match it; the prototype is authoritative for layout, copy, states and interactions. Styling was extracted from the live staging app (violet-outline selections, dot-stop sliders, gradient reserved for CTAs/hero) so it already matches production tokens.

Signed off by Lee across the 2026-07-22/23 design session ("this looks waaaaayyyyy better — implement").

## The model (locked)
- **An agent = a saved Cascade = a preset over primitives.** Two layers:
  - **Global "taste baseline" (account-level, set once, inherited by every agent):** Genres, How-far-back, Language, Age. Permissive defaults (all genres, any era, English, all ages). This is NOT asked up front — it's a page you can open and edit; agents inherit it. Changing it re-narrows every agent at once.
  - **Per-agent = Channel × Standard (+ optional Focus):** Channel = where/when it hunts (availability, a hard fixed filter). Standard = the bar (the dials). Each agent surfaces only the 2–3 dials that define its purpose; the rest sit under "More controls" with sensible defaults.
- **Filter vs rank discipline:** availability + the taste-baseline boundaries are hard filters; quality/scale/buzz rank & lean.

## Locked decisions
1. **Dials combine with AND** (a film must meet every control you turn up). This **reverses the earlier OR decision on CAS-114** — reconcile that ticket. Live count is the guardrail against over-narrowing.
2. **People's vote is a continuous slider** (tap a number to snap, or slide anywhere) with a live readout ("Well-liked · 7.4+"), meaningful range 5.0–9.0. Critics/Budget/Buzz stay stepped (they mix score+awards or are genuinely tiered).
3. **Buzz is a new dial** (Any · Talked-about · Trending · Must-see) driven by **TMDB popularity** — the one new data primitive (see Buzz-signal ticket). Data is already ingested (discover sorts by popularity); it needs surfacing into `movies.json` + filter logic.
4. **Every slider fills from the left edge to its value** (gradient fill bar + lit dots up to the point) — unified across People's vote, Critics, Budget, Buzz and the year slider.
5. **Plain-English copy** — no "TMDB", no "a lean, not a hard cut". Budget = "How big the film is — from a small indie to a huge blockbuster"; Buzz = "How much people are talking about it right now".
6. **Age rating is a range** — pick a lowest AND highest (e.g. PG → MA 15+), gradient-filled band, no handles/dots. Default full G → R 18+. **Changes CAS-140** (was remove-E/RC + up-to-including) — a floor now excludes below it.
7. **Get selective (#3) = a hub with progress + payoff:** two doors ("The bar" → #4, "Your taste baseline" → the baseline page). Hitting Continue/Done on a door returns you with that door in a **completed state** (green border, green ✓, a one-time pulse) and the top progress bar advances. **No "keep it broad" escape.** Only when **both** are confirmed does a gradient **"Show me my N films →"** CTA appear, leading to a completion/reveal screen.
8. **"boxes = tappable"** convention: cards/boxes are reserved for selectable/interactive elements. Passive summaries (the "what this does" line, notes) are plain text, never boxed.
9. **Colour rule:** violet (`--selink`/`--accent`) = selections, values, hero numbers; gradient = primary CTAs + hero number. Candy-shop counts are **violet** (aligned; were green). Open option: reserve one green accent app-wide for "films found" counts — Lee to decide (default: all-violet).
10. **Streaming channel label** must not say "your services" until services are added — show "Streaming" + "On the big streaming services until you add your own."

## Per-agent defaults (from the prototype)
- **Must See at the Cinema** — In cinemas · primary Budget+Buzz · Blockbuster + Must-see buzz · taste off.
- **Awesome Movies for Rent** — New to rent · primary People's vote + Critics · Loved + Acclaimed.
- **Date Night Rentals** — On rent · primary People's vote + Buzz · Well-liked + Talked-about.
- **My Day to Day Streaming** — Streaming · primary People's vote + Buzz · **Liked 6.0** floor + **Talked-about** · taste ON.
- **Nominees & Awards** — Anywhere · primary Critics · Nominee/Winner.

## Standing build rules
- Build to **staging** only, **never main**. Don't modify the production film card component (CAS-100). Guest / localStorage; truthful copy (counts must be real once wired to data). Prototype counts are synthetic — wire to the live catalogue.
