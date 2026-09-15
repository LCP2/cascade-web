"""CAS-974: one shared per-day run-stats file, `state/run_stats.json`, that daily.yml's separate
steps (poc_pipeline.py's ingest, the monitor's notification digest, the Contact-us digest) each
add their own numbers into, and `monitor.health` reads back afterwards to assert the night's work
actually happened — a green job is not evidence anything real happened until something checks.

Two write modes, same file:
  bump()      — add a delta onto a counter (calls/errors/attempted/delivered — anything that
                accumulates across the day's several writer steps).
  set_value() — overwrite a point-in-time figure (Watchmode's remaining monthly credits) that
                the LATEST writer's answer replaces rather than sums.

The file resets itself the moment its own `date` stops matching today, the same one-run-per-day
rule `state/api_budget.json` already applies to Watchmode's daily spend (poc_pipeline.py).
"""
from __future__ import annotations

import datetime as _dt
import json
import os

_REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
STATS_FILE = os.path.join(_REPO_ROOT, "state", "run_stats.json")


def _today_iso(today) -> str:
    return (today or _dt.date.today()).isoformat()


def _load(today_iso: str) -> dict:
    if not os.path.exists(STATS_FILE):
        return {"date": today_iso}
    try:
        data = json.load(open(STATS_FILE, encoding="utf-8"))
    except Exception:
        return {"date": today_iso}
    return data if data.get("date") == today_iso else {"date": today_iso}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(STATS_FILE), exist_ok=True)
    json.dump(data, open(STATS_FILE, "w", encoding="utf-8"), indent=2)


def bump(section: str, today=None, **deltas: int) -> None:
    """Add each keyword's value onto today's run_stats.json[section][key]."""
    data = _load(_today_iso(today))
    bucket = data.setdefault(section, {})
    for key, delta in deltas.items():
        bucket[key] = bucket.get(key, 0) + delta
    _save(data)


def set_value(section: str, today=None, **values) -> None:
    """Overwrite (never add) — for a point-in-time figure such as Watchmode's remaining credits."""
    data = _load(_today_iso(today))
    bucket = data.setdefault(section, {})
    bucket.update(values)
    _save(data)


def load(today=None) -> dict:
    """Today's stats, or just {"date": ...} if nothing has written yet today."""
    return _load(_today_iso(today))
