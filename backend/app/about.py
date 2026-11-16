"""Which version of the add-on is running, and the day that version was released.

The release date comes from the changelog, whose headings read `## 1.29.0 - 2026-11-16: Title`. Every
version bump already gets an entry there (Home Assistant shows it as "What's new"), so the date is
the one the entry was written under, and nothing new has to be remembered at runtime.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

HEADING = re.compile(r"^##\s+(\S+)\s+-\s+(\d{4}-\d{2}-\d{2})(?::\s*(.*))?$")


def release_of(version: str, changelog: Path) -> dict[str, str | None] | None:
    """The date (and title) the changelog gives `version`, or None when it has no entry."""
    try:
        for line in changelog.read_text().splitlines():
            match = HEADING.match(line.strip())
            if match and match.group(1) == version:
                return {"releasedOn": match.group(2), "title": (match.group(3) or "").strip() or None}
    except OSError:
        pass
    return None


def about(version: str, changelog: Path) -> dict[str, Any]:
    release = release_of(version, changelog) or {}
    return {"version": version, "releasedOn": release.get("releasedOn"), "title": release.get("title")}
