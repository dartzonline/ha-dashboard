"""The running version and the day it was released, read from the changelog."""

from pathlib import Path

from app import about

CHANGELOG = """# Changelog

## 1.29.0 - 2026-11-16: Version in Settings

Words.

## 1.28.0 - 2026-11-15: One Share button
"""


def test_reads_the_release_day_and_title_for_a_version(tmp_path):
    path = tmp_path / "CHANGELOG.md"
    path.write_text(CHANGELOG)
    assert about.release_of("1.29.0", path) == {"releasedOn": "2026-11-16", "title": "Version in Settings"}
    assert about.release_of("1.28.0", path)["releasedOn"] == "2026-11-15"


def test_a_version_without_an_entry_or_a_missing_file_is_just_unknown(tmp_path):
    path = tmp_path / "CHANGELOG.md"
    path.write_text(CHANGELOG)
    assert about.about("9.9.9", path) == {"version": "9.9.9", "releasedOn": None, "title": None}
    assert about.about("1.29.0", tmp_path / "missing.md")["releasedOn"] is None


def test_the_running_version_has_a_changelog_entry_with_a_date():
    """A version bump without a changelog entry would leave Settings with no release date."""
    from fastapi.testclient import TestClient

    from app.main import app, addon_version

    body = TestClient(app).get("/api/about").json()
    assert body["version"] == addon_version()
    assert body["releasedOn"], f"CHANGELOG.md has no dated entry for {body['version']}"
    assert (Path(__file__).resolve().parents[2] / "Dockerfile").read_text().count("COPY CHANGELOG.md") == 1
