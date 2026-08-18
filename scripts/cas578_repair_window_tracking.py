#!/usr/bin/env python3
"""
CAS-578 R5 — one-off repair of the window_dates / status corruption D1/D2 measured.

Run once, by hand, from the repo root:
    python scripts/cas578_repair_window_tracking.py

No network calls — repairs purely from each title's own ALREADY-STORED `offers` (the exact same
evidence R2/R3 now gate the ongoing daily writer on), against the CURRENT movies.json +
state/window_dates.json:

  D1 (in-cinema titles carrying a home-window history they never had): any pvod/rental/
     included_streaming entry in window_dates with no CURRENT offer of the matching type is removed.
  D2 (a window claimed in `status` with nothing behind it, e.g. included_streaming with no sub/free
     offer): `status` is recomputed from the title's own stored offers + cinema_date (mirrors
     derive_from_providers' per-offer/offer-less-fallback logic, not derive_status, which assumes
     Watchmode's real prices and would wrongly blank a TMDB-sourced, price-less rent/buy offer).

Both repairs use the SAME "no current offer of the matching type" test the ticket's own AC5/AC6
counts use — a real, if occasionally aggressive, one-off correction: a title whose last live poll
happened to catch a transient AU-provider gap (rather than a genuine departure) will also lose its
stamp here. That is an accepted one-off trade-off (the ticket's own repair criterion), NOT how the
ONGOING pipeline behaves any more — update_window_dates only ever removes a stamp on a monotonic-
guard-CONFIRMED status departure (see poc_pipeline.py), which a single stale snapshot can't trigger.

Writes movies.json, state/window_dates.json AND state/last_snapshot.json (so the next real daily
run's arrival/departure diff starts from what THIS repair committed, not from the corruption it just
fixed — otherwise every corrected title would read as a brand-new "departure" tomorrow and flood the
alert log). Also writes state/cas578_window_tracking_repair.json: a permanent, committed log of
exactly what was removed/changed and why (R5: "do not silently rewrite history").
"""
from __future__ import annotations
import datetime, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import poc_pipeline as pp  # noqa: E402

REPORT_FILE = os.path.join(pp.STATE_DIR, "cas578_window_tracking_repair.json")


def _offer_windows(m: dict) -> set:
    return {w for w in (pp._window_of(o) for o in m.get("offers", [])) if w}


def _status_from_offers(m: dict, today: datetime.date) -> list:
    """A faithful REPLICA of derive_from_providers' own priority — sub/free/ads beats rent/buy beats
    the offer-less cinema-date fallback — driven by the title's stored `offers` instead of a live
    `prov` read. Deliberately NOT the more generous "every offer independently" model: that would
    ADD windows (e.g. stamp pvod alongside rental just because a buy row also exists) that the live
    pipeline itself would never have produced, which is a broader behaviour change than this ticket's
    D1/D2 corruption calls for (see the CAS-578 Watch-out: don't fold multi-window into a single
    model, but don't invent a wider one either — AC9 only asks that an ALREADY multi-window title,
    e.g. derive_status' Watchmode-enriched path, keeps both; it does not ask this repair to discover
    new ones the primary derivation was never designed to report)."""
    offers = m.get("offers", [])
    has_sub = any(o.get("type") in ("sub", "free") for o in offers)
    has_rent = any(o.get("type") == "rent" for o in offers)
    has_buy = any(o.get("type") == "buy" for o in offers)
    if has_sub:
        windows = {"included_streaming"}
    elif has_rent or has_buy:
        windows = {"rental" if has_rent else "pvod"}
    else:
        windows = set()
    if not windows:
        cd = m.get("cinema_date")
        opened = bool(cd and cd <= today.isoformat())
        still_running = opened and cd >= (today - datetime.timedelta(days=pp.CINEMA_RUN_DAYS)).isoformat()
        windows = {"in_cinema" if still_running else "upcoming"}
    return sorted(windows)


def repair(today: datetime.date) -> dict:
    doc = json.load(open(pp.OUTPUT_FILE, encoding="utf-8"))
    movies = doc["movies"]
    wd = json.load(open(pp.WINDOW_DATES_FILE, encoding="utf-8")) if os.path.exists(pp.WINDOW_DATES_FILE) else {}

    def count_d1(ms):
        return sum(1 for m in ms if "in_cinema" in m.get("status", [])
                   and set((m.get("window_dates") or {}).keys()) & pp.HOME_WINDOWS)

    def count_d2(ms):
        return sum(1 for m in ms if "included_streaming" in m.get("status", [])
                   and not any(o.get("type") in ("sub", "free") for o in m.get("offers", [])))

    before_d1, before_d2 = count_d1(movies), count_d2(movies)

    removed_entries, status_changes = [], []
    for m in movies:
        key = str(m["tmdb_id"])
        rec = wd.get(key, dict(m.get("window_dates") or {}))
        offer_windows = _offer_windows(m)

        old_status = list(m.get("status", []))
        new_status = _status_from_offers(m, today)
        if set(new_status) != set(old_status):
            status_changes.append({"tmdb_id": m["tmdb_id"], "title": m["title"],
                                    "before": old_status, "after": new_status})
            m["status"] = new_status
            m["availability_confidence"] = "confirmed" if m.get("offers") else "estimated"

        for w in list(rec):
            if w in pp.HOME_WINDOWS and w not in offer_windows:
                removed_entries.append({"tmdb_id": m["tmdb_id"], "title": m["title"], "window": w,
                                         "stamped": rec[w],
                                         "reason": "no current offer of this type corroborates it"})
                rec.pop(w, None)

        wd[key] = rec
        m["window_dates"] = rec

    after_d1, after_d2 = count_d1(movies), count_d2(movies)

    doc["movies"] = movies
    json.dump(doc, open(pp.OUTPUT_FILE, "w", encoding="utf-8"), indent=2)
    os.makedirs(pp.STATE_DIR, exist_ok=True)
    json.dump(wd, open(pp.WINDOW_DATES_FILE, "w", encoding="utf-8"), indent=2)
    # Keep the next real run's arrival/departure diff honest: it must start from what THIS repair
    # committed, not from the corruption it just fixed.
    json.dump(movies, open(pp.SNAPSHOT_FILE, "w", encoding="utf-8"), indent=2)

    report = {
        "run_date": today.isoformat(),
        "before": {"in_cinema_with_impossible_home_window": before_d1,
                   "included_streaming_with_no_sub_offer": before_d2},
        "after": {"in_cinema_with_impossible_home_window": after_d1,
                  "included_streaming_with_no_sub_offer": after_d2},
        "window_dates_entries_removed": len(removed_entries),
        "status_changes": len(status_changes),
        "removed_entries": removed_entries,
        "status_change_detail": status_changes,
    }
    json.dump(report, open(REPORT_FILE, "w", encoding="utf-8"), indent=2)
    return report


if __name__ == "__main__":
    r = repair(datetime.date.today())
    print(f"D1 (in-cinema w/ impossible home window):  {r['before']['in_cinema_with_impossible_home_window']} "
          f"-> {r['after']['in_cinema_with_impossible_home_window']}")
    print(f"D2 (included_streaming w/ no sub offer):    {r['before']['included_streaming_with_no_sub_offer']} "
          f"-> {r['after']['included_streaming_with_no_sub_offer']}")
    print(f"window_dates entries removed: {r['window_dates_entries_removed']}")
    print(f"status changes: {r['status_changes']}")
    print(f"full log: {REPORT_FILE}")
