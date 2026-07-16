"""Load today's and yesterday's catalogues for the diff.

Today is the freshly-built ``movies.json``. Yesterday is the *previous commit's* copy of
the same file — retrieved for free with ``git show HEAD~1:movies.json`` (no snapshot to
store, no network). Both accept either the wrapped ``{"movies": [...]}`` shape that
poc_pipeline writes or a bare list.
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


def load_yesterday_from_git(ref: str = "HEAD~1", rel_path: str = "movies.json") -> list:
    """Yesterday's catalogue from git history. Returns [] if there is no previous commit
    (e.g. the very first run) so the caller degrades to 'everything is a first sighting'."""
    try:
        out = subprocess.run(
            ["git", "show", f"{ref}:{rel_path}"],
            cwd=_REPO_ROOT, capture_output=True, text=True,
        )
    except FileNotFoundError:
        return []  # git not available
    if out.returncode != 0 or not out.stdout.strip():
        return []  # no such ref / file (first commit) -> no "yesterday"
    return movies_of(json.loads(out.stdout))
