# QA footprint

One command runs the whole gate:

```bash
npm run qa
```

That is `build → engine → data → monitor → e2e`, in that order, and it exits non-zero on the first red.
**Build first is not optional**: every suite tests the built `index.html`, so running them against a stale
build tests yesterday's app. `npm run qa` does the build for you; running a suite by hand does not.

| Suite | Command | What it proves |
| --- | --- | --- |
| Engine invariants (CAS-231) | `node --test tests/js/invariants.test.mjs` | The arithmetic is coherent: a count equals its set, narrowing never widens, a facet is no bigger than the set it slices. |
| Data integrity (CAS-255) | `node --test tests/js/data-integrity.test.mjs` | The claims about a FILM hold: every listed film has a resolved, labelled window; the dates on a card are real; the scale dial leans rather than cuts at every rung; the my-services scope only ever narrows. |
| Data quality (CAS-233, CAS-255) | `python -m unittest discover -s tests` | The catalogue is worth reasoning about: records are internally coherent, and the showable half carries the fields the UI leans on. |
| Monitor (pre-existing) | `python -m unittest discover -s monitor/tests` plus `python -m monitor --dry-run` | The notifier's rules and its de-dupe. |
| End to end (CAS-232) | `npx playwright test` | A real browser walking the built page. |

## The two rules every assertion here follows

1. **Nothing pins a number.** `main` refreshes the catalogue daily, so an assertion that today's catalogue
   holds 1,961 films is red by tomorrow morning and teaches everyone to ignore the suite. What is asserted is
   the relationship: a count equals the set it counts, a slice fits inside its whole, an observed date is
   after the film opened.
2. **Where a threshold is unavoidable, it is a ratchet.** A share of the catalogue missing a field cannot be
   asserted at zero without failing on the first day the upstream feed hiccups. So the ceiling sits above
   today's measurement, the failure message prints what the number actually is, and the test's job is to catch
   it climbing — never to certify it as good. Every ratchet in the repo names the ticket that owns closing it.

## Policy (CAS-255)

Every logical or data defect fixed gets a regression test **in the same change** as the fix. A fix with no
test is a defect waiting to come back, and the whole point of this footprint is that the gate finds these
rather than Lee.

## Known gaps, each owned by a ticket

* **`cinema/prestige` lists nothing** — the cinema presets carry criteria on dials the cinema lane neither
  shows nor relaxes, so an awards rung nobody can see empties the agent. Held by a ratchet
  (`EMPTY_OFFERS_TODAY`) in `tests/js/data-integrity.test.mjs`; owned by CAS-231 / CAS-237. See the KNOWN GAP
  comment beside `MISSION_DIALS_USED` in `app_template.html`.
* **Films still labelled Upcoming after their opening date** — the latch lives in
  `poll_scheduler.classify_tier`, which the front end can only sharpen, not fix. Held by a tolerance in
  `tests/test_data_quality.py`; owned by CAS-227.

## CI

`qa.yml` — running this gate on every push to `staging` and blocking promotion on red — is **CAS-236**. The
workflow is written and sits in **`ci/qa.yml`**, one `git mv` from being live; it is not in
`.github/workflows/` because the CC autonomy contract bars CC from writing there, on the reasoning that a bot
which can edit its own CI can edit the gate that checks it. `ci/README.md` has the two-line install and the
promote-gate step that goes with it.

Until it is installed, `npm run qa` before a promote is the gate.
