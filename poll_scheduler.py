#!/usr/bin/env python3
"""
CAS-109 — poll tiering + free-tier-capped daily scheduler + status estimator.

Pure functions over catalogue records + accrued window_dates. NO API keys needed
(these decide WHAT to poll and estimate the rest; the actual Watchmode call stays
in poc_pipeline.poll_watchmode). Free tier only (locked 2026-07-20: no paid yet).

Tiers:
  none   : upcoming / cinema date still ahead        -> never polled
  active : window in {in_cinema,pvod,rental} OR AU cinema release <= 6 months
           (even if already on streaming)            -> polled DAILY (capped)
  slow   : settled on streaming AND > 6 months       -> 4-week round-robin sweep
"""
import datetime, statistics

JOURNEY = ["upcoming", "opening_week", "in_cinema", "pvod", "rental", "included_streaming"]
ACTIVE_WINDOW = {"in_cinema", "pvod", "rental"}
SIX_MONTHS = 180

# --- free-tier budget (locked: stay free) ----------------------------------
FREE_MONTHLY   = 2500
DAILY_BUDGET   = 80      # ~2500/31, integer daily ceiling
ONDEMAND_RESERVE = 15    # calls/day held for user-triggered confirms
ACTIVE_CAP     = 65      # max daily-active titles (<= free ceiling ~68; keeps headroom)
SWEEP_DAYS     = 28      # 4-week slow sweep

# estimate model fallback: median days from cinema to each downstream window
DEFAULT_OFFSETS = {"pvod": 75, "rental": 120, "included_streaming": 210}


def _date(s):
    try: return datetime.date.fromisoformat(s) if s else None
    except Exception: return None

def cinema_date(m): return _date(m.get("cinema_date"))


def classify_tier(m, today):
    st = set(m.get("status", []))
    c = cinema_date(m)
    if (c and c > today) or st == {"upcoming"}:
        return "none"
    recent = bool(c and 0 <= (today - c).days <= SIX_MONTHS)
    if (st & ACTIVE_WINDOW) or recent:
        return "active"
    return "slow"


def select_daily_poll_set(movies, today, ondemand_ids=None,
                          active_cap=ACTIVE_CAP, daily_budget=DAILY_BUDGET,
                          reserve=ONDEMAND_RESERVE, sweep_days=SWEEP_DAYS):
    """Choose the titles to Watchmode-poll TODAY inside the free-tier cap.
    Priority: active (by popularity, capped) -> slow round-robin fills what's left.
    On-demand is served immediately and counts against the reserve."""
    ondemand_ids = set(ondemand_ids or [])
    active = [m for m in movies if classify_tier(m, today) == "active"]
    slow   = [m for m in movies if classify_tier(m, today) == "slow"]

    active.sort(key=lambda m: m.get("popularity") or 0, reverse=True)
    capped_active  = active[:active_cap]
    skipped_active = active[active_cap:]              # overflow -> demoted to sweep

    slow_pool = skipped_active + slow                 # sweep also mops up active overflow
    slow_pool.sort(key=lambda m: _date(m.get("last_polled")) or datetime.date.min)
    fair_share = -(-len(slow_pool) // sweep_days)      # ceil: keep the whole tail on rotation
    remaining  = max(0, daily_budget - reserve - len(capped_active))
    slow_today = slow_pool[:min(fair_share, remaining)]

    return {
        "active":   capped_active,
        "slow":     slow_today,
        "ondemand": [m for m in movies if m.get("tmdb_id") in ondemand_ids],
        "counts": {
            "active": len(capped_active), "active_total": len(active),
            "skipped_active": len(skipped_active),
            "slow_today": len(slow_today), "slow_pool": len(slow_pool),
            "daily_calls": len(capped_active) + len(slow_today),
            "est_monthly": round((len(capped_active) + len(slow_today)) * 30 + reserve * 30),
        },
    }


def compute_median_offsets(window_dates, defaults=DEFAULT_OFFSETS, min_samples=5):
    """Median days from cinema to each downstream window, learned from accrued
    window_dates; fall back to defaults until enough samples exist."""
    samples = {w: [] for w in ("pvod", "rental", "included_streaming")}
    for wd in window_dates.values():
        base = _date(wd.get("in_cinema") or wd.get("opening_week"))
        if not base:
            continue
        for w in samples:
            d = _date(wd.get(w))
            if d and (d - base).days >= 0:
                samples[w].append((d - base).days)
    return {w: (int(statistics.median(xs)) if len(xs) >= min_samples else defaults[w])
            for w, xs in samples.items()}


def estimate_status(m, today, offsets=DEFAULT_OFFSETS):
    """Estimated current window for an UNPOLLED film from its cinema age.
    Returns (window, 'estimated'). Never fabricates price/services."""
    c = cinema_date(m)
    if not c or c > today:
        return ("upcoming", "estimated")
    age = (today - c).days
    if   age >= offsets["included_streaming"]: w = "included_streaming"
    elif age >= offsets["rental"]:             w = "rental"
    elif age >= offsets["pvod"]:               w = "pvod"
    else:                                      w = "in_cinema"
    return (w, "estimated")
