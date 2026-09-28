"""Crash-safe file replacement for the handful of small JSON files this backend persists.

`Path.write_text` truncates the target before it writes, so a power cut or an OOM kill between
those two steps leaves a zero-byte file behind -- and every one of the files that go through here
(the dashboard config, the photo index, the flight quota) is read back with "unreadable means
empty" semantics, so a torn write would silently reset the household's configuration. Writing to a
sibling temp file and `os.replace`-ing it over the target makes the swap atomic on every platform
this runs on: readers see the old contents or the new contents, never a half-written mix.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def write_text_atomic(path: Path, text: str, encoding: str = "utf-8") -> None:
    """Replace `path`'s contents with `text` in one step.

    The temp file is created in the same directory as `path` because `os.replace` is only atomic
    within one filesystem -- a temp file under `/tmp` could sit on a different mount than `/data`.
    Any failure leaves the original untouched and cleans up the temp file.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise
