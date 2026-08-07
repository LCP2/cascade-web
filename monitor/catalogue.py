"""Load today's and yesterday's catalogues for the diff.

Today is the freshly-built ``movies.json``. "Yesterday" is the most recent commit that
touched ``movies.json`` on an EARLIER calendar day (UTC) than today's commit — retrieved
for free from git history (no snapshot to store, no network). Both accept either the
wrapped ``{"movies": [...]}`` shape that poc_pipeline writes or a bare list.

Why not simply HEAD~1? Because "the previous commit" is not "yesterday" whenever more than
one commit lands between monitor runs — a manual re-run, a second refresh the same day, a
promote, or a code fix. In those cases HEAD~1 is a build from hours ago, the diff is empty,
and no one is notified about changes that really happened. Anchoring to the last refresh on
an earlier DAY makes the diff robust to all of that (CAS baseline fix). Falls back to HEAD~1,
then to "no yesterday", so a shallow clone or a first run degrades safely rather than crashing.
"""
from __future__ import annotations

import json
import os
import subprocess

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MOVIES_JSON = os.path.join(_REPO_ROOT, "movies.json")


def movies_of(doc) -> list:
    """Normalise a catalogue document to a plain list of movie records."""
    if isinstance(doc, dict):
        return doc.get("movies", []) or []
    return doc or []


def load_catalogue_file(path: str) -> list:
    with open(path, encoding="utf-8") as fh:
        return movies_of(json.load(fh))


def load_today(path: str = MOVIES_JSON) -> list:
    return load_catalogue_file(path)


def _git(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=_REPO_ROOT, capture_output=True, text=True)


def _movies_at(ref: str, rel_path: str) -> list:
    """movies.json as of a git ref, or [] if the ref/blob is unavailable."""
    out = _git("show", f"{ref}:{rel_path}")
    if out.returncode != 0 or not out.stdout.strip():
        return []
    try:
        return movies_of(json.loads(out.stdout))
    except json.JSONDecodeError:
        return []


def _prior_day_ref(rel_path: str) -> str | None:
    """SHA of the most recent commit touching ``rel_path`` on an earlier UTC calendar day than
    the newest such commit. None if history has only same-day commits (or is too shallow)."""
    out = _git("log", "--format=%H %cd", "--date=format:%Y-%m-%d", "--", rel_path)
    if out.returncode != 0 or not out.stdout.strip():
        return None
    rows = [ln.split() for ln in out.stdout.strip().splitlines() if ln.strip()]
    if not rows:
        return None
    head_day = rows[0][1]                       # newest commit's day == "today" for the diff
    for sha, day in rows:
        if day < head_day:                      # first (newest) commit from any earlier day
            return sha
    return None


def load_yesterday_from_git(rel_path: str = "movies.json") -> list:
    """Yesterday's catalogue from git history — the last refresh on an earlier calendar day.
    Falls back to HEAD~1, then to [] (first run / shallow clone) so the caller degrades to
    'everything is a first sighting' rather than crashing."""
    try:
        ref = _prior_day_ref(rel_path)
        if ref:
            prior = _movies_at(ref, rel_path)
            if prior:
                return prior
        # Fallbacks: previous commit, then nothing.
        return _movies_at("HEAD~1", rel_path)
    except FileNotFoundError:
        return []  # git not available
