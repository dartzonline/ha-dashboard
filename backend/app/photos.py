"""Personal photo library: add pictures by upload or by URL, list them, reorder them, delete them.

This module is deliberately just the library -- storing, processing, listing, serving and removing
images. Where and how photos get *displayed* on the wall panel is a separate decision; nothing here
assumes a particular display surface, so that choice can change without touching storage.

Files live under the same persistent-volume convention as everything else that has to survive a
restart (`dashboard_config.py`, `flight_sources.Budget`): `/data` when running as the Home Assistant
add-on, a repo-local `backend/data/` fallback otherwise. A small JSON index sits alongside the image
files themselves and is the source of truth for metadata; the files are named by id, not by the
original filename, so two uploads called "photo.jpg" never collide.

**Every photo is processed on the way in** rather than served as uploaded. A modern phone photo is
~4000px wide and several megabytes; a wall tablet is ~1920px and will never show more than that, so
storing the original wastes disk and makes every page load drag a file through the network that the
screen then throws most of away. On add, each image is:

* rotated upright per its EXIF orientation, because a phone stores a portrait photo as landscape
  plus a "rotate me" tag, and an `<img>` that ignores the tag shows it sideways;
* downscaled to fit the panel (never upscaled -- enlarging a small photo only invents pixels);
* re-encoded once at a visually-lossless quality, with EXIF stripped (it carries GPS coordinates
  among other things, which has no business being served to the wall panel);
* given a small thumbnail, so the manage screen can show a whole library at once without
  downloading full-size images to draw 150px tiles.
"""

from __future__ import annotations

import io
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/photos")

# Generous enough for an ordinary phone photo, bounded so one add can't fill the disk. This is the
# limit on what is *accepted*; what gets stored is far smaller after processing.
MAX_PHOTO_BYTES = 20 * 1024 * 1024

# The wall tablet is a 1080p-class panel. Storing more than it can physically show is wasted disk
# and wasted transfer on every load, and the extra detail is invisible by definition. Sized a
# little above 1920x1080 so a photo that doesn't match the panel's aspect ratio still fills it.
DISPLAY_MAX_WIDTH = 2048
DISPLAY_MAX_HEIGHT = 1536

# Small enough that a whole library's thumbnails cost less than one full photo, big enough to stay
# sharp on a high-DPI phone while managing the list.
THUMBNAIL_MAX = 400

# JPEG quality 88 is the usual "visually lossless" mark -- above it file size climbs fast for
# differences nobody can see at arm's length on a tablet. Kept as a constant rather than inlined
# because it is a judgement call worth finding when revisiting image quality.
DISPLAY_QUALITY = 88
THUMBNAIL_QUALITY = 78

# content-type -> file extension. Deliberately narrow: this is a photo frame, not a general file
# store, and every format here is something a browser can decode natively with an <img> tag.
ALLOWED_CONTENT_TYPES: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}

# What processed images are written as, regardless of what came in. One format out means the
# display path never has to care what someone happened to upload.
STORED_CONTENT_TYPE = "image/jpeg"
STORED_EXTENSION = "jpg"

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9 ._-]")


def _data_dir() -> Path:
    root = Path("/data")
    if not root.is_dir():
        root = Path(__file__).resolve().parents[1] / "data"
    photos_dir = root / "photos"
    photos_dir.mkdir(parents=True, exist_ok=True)
    return root


def _photos_dir() -> Path:
    return _data_dir() / "photos"


def _index_path() -> Path:
    return _data_dir() / "photos.json"


def _load_index() -> list[dict[str, Any]]:
    path = _index_path()
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        logger.warning("photos index unreadable, starting fresh: %s", error)
        return []
    return payload if isinstance(payload, list) else []


def _save_index(entries: list[dict[str, Any]]) -> None:
    path = _index_path()
    try:
        path.write_text(json.dumps(entries, indent=2))
    except OSError as error:
        logger.warning("could not persist photos index: %s", error)


def _safe_name(name: str | None) -> str | None:
    """A user-supplied filename, kept for display only -- never used as a path.

    Nothing here ever reads this value back as a filesystem path (the stored file is always named
    from the photo's own id), so this is display hygiene rather than a security boundary: a name
    that still looked like "../../etc/passwd.jpg" after cleaning would be confusing to see in a
    photo library regardless of whether it could do anything.
    """
    if not name:
        return None
    cleaned = _FILENAME_UNSAFE.sub("", name).replace("..", "").strip(" .")
    return cleaned[:120] or None


def list_photos() -> list[dict[str, Any]]:
    """In display order.

    `position` is the running order the manage screen controls, so it -- not upload time -- is what
    both the library list and any slideshow follow. `addedAt` only breaks ties, which matters for
    photos added before ordering existed and therefore share a default position of 0.
    """
    return sorted(_load_index(), key=lambda entry: (int(entry.get("position", 0)), str(entry.get("addedAt", ""))))


def photo_record(photo_id: str) -> dict[str, Any] | None:
    for entry in _load_index():
        if entry.get("id") == photo_id:
            return entry
    return None


def photo_file_path(photo_id: str, thumbnail: bool = False) -> Path | None:
    record = photo_record(photo_id)
    if not record:
        return None
    key = "thumbName" if thumbnail else "storedName"
    name = record.get(key)
    if not name:
        return None
    path = _photos_dir() / str(name)
    return path if path.is_file() else None


def reorder_photos(ordered_ids: list[str]) -> list[dict[str, Any]]:
    """Applies a new running order, given the ids in the order they should appear.

    Ids not mentioned keep their relative order after the ones that were, so a reorder computed
    from a stale list cannot silently drop a photo added since it was fetched.
    """
    entries = _load_index()
    ranking = {photo_id: index for index, photo_id in enumerate(ordered_ids)}
    fallback = len(ranking)
    ordered = sorted(
        entries,
        key=lambda entry: (ranking.get(str(entry.get("id")), fallback), int(entry.get("position", 0))),
    )
    for index, entry in enumerate(ordered):
        entry["position"] = index
    _save_index(ordered)
    return list_photos()


def _encode(image: Image.Image, box: tuple[int, int], quality: int) -> tuple[bytes, int, int]:
    """Fit `image` inside `box` and encode it as JPEG. Returns (bytes, width, height).

    Only ever shrinks: `ImageOps.contain` scales in both directions, so it is guarded here rather
    than called unconditionally. Enlarging a photo that is already smaller than the panel would add
    bytes and blur to a picture without adding any detail to it.
    """
    fitted = image
    if image.width > box[0] or image.height > box[1]:
        fitted = ImageOps.contain(image, box, Image.LANCZOS)
    buffer = io.BytesIO()
    # optimize + progressive are free at display time and meaningfully smaller on disk; no EXIF is
    # passed through, so the GPS coordinates a phone attaches never reach the panel.
    fitted.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue(), fitted.width, fitted.height


def process_image(data: bytes) -> tuple[bytes, bytes, dict[str, Any]]:
    """(display bytes, thumbnail bytes, dimensions) for one uploaded image.

    Raises ValueError for anything Pillow cannot decode, which covers both a corrupt file and a
    non-image that arrived with an image content-type.
    """
    try:
        with Image.open(io.BytesIO(data)) as opened:
            # A phone writes portrait photos as landscape plus an EXIF "rotate me" tag; this bakes
            # the rotation in, so the panel does not have to honour a tag that is about to be
            # stripped anyway.
            upright = ImageOps.exif_transpose(opened)
            # JPEG has no alpha channel. Flattening onto black rather than white because every
            # surface this gets displayed on is dark.
            if upright.mode in ("RGBA", "LA", "P"):
                converted = upright.convert("RGBA")
                flattened = Image.new("RGB", converted.size, (0, 0, 0))
                flattened.paste(converted, mask=converted.split()[-1])
                upright = flattened
            elif upright.mode != "RGB":
                upright = upright.convert("RGB")

            original_width, original_height = upright.size
            display, width, height = _encode(upright, (DISPLAY_MAX_WIDTH, DISPLAY_MAX_HEIGHT), DISPLAY_QUALITY)
            thumbnail, _, _ = _encode(upright, (THUMBNAIL_MAX, THUMBNAIL_MAX), THUMBNAIL_QUALITY)
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ValueError("That file could not be read as an image") from error

    return display, thumbnail, {
        "width": width,
        "height": height,
        "originalWidth": original_width,
        "originalHeight": original_height,
    }


def add_photo(data: bytes, content_type: str, original_name: str | None, source_url: str | None) -> dict[str, Any]:
    """Validates, processes, writes the files, records it in the index, and returns the new entry.

    Raises ValueError with a message safe to show the person adding the photo -- the callers below
    turn that straight into the HTTP error, so it has to already read like an explanation, not a
    stack trace.
    """
    if not data:
        raise ValueError("The image was empty")
    if len(data) > MAX_PHOTO_BYTES:
        raise ValueError(f"Image is larger than the {MAX_PHOTO_BYTES // (1024 * 1024)} MB limit")
    if content_type.split(";")[0].strip().lower() not in ALLOWED_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type: {content_type or 'unknown'}")

    display, thumbnail, dimensions = process_image(data)

    photo_id = f"photo_{uuid.uuid4().hex}"
    stored_name = f"{photo_id}.{STORED_EXTENSION}"
    thumb_name = f"{photo_id}_thumb.{STORED_EXTENSION}"
    (_photos_dir() / stored_name).write_bytes(display)
    (_photos_dir() / thumb_name).write_bytes(thumbnail)

    entries = _load_index()
    entry = {
        "id": photo_id,
        "storedName": stored_name,
        "thumbName": thumb_name,
        "originalName": _safe_name(original_name),
        "contentType": STORED_CONTENT_TYPE,
        "sizeBytes": len(display),
        "thumbBytes": len(thumbnail),
        # Kept so the manage screen can say how much processing actually saved, which is the only
        # visible evidence that it happened at all.
        "originalBytes": len(data),
        **dimensions,
        "addedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceUrl": source_url,
        # Appended to the end of the running order; the manage screen can move it afterwards.
        "position": max((int(item.get("position", 0)) for item in entries), default=-1) + 1,
    }
    entries.append(entry)
    _save_index(entries)
    return entry


def delete_photo(photo_id: str) -> bool:
    entries = _load_index()
    remaining = [entry for entry in entries if entry.get("id") != photo_id]
    if len(remaining) == len(entries):
        return False
    removed = next(entry for entry in entries if entry.get("id") == photo_id)
    # Both files, or deleting a library would leave its thumbnails behind forever.
    for key in ("storedName", "thumbName"):
        name = removed.get(key)
        if name:
            (_photos_dir() / str(name)).unlink(missing_ok=True)
    _save_index(remaining)
    return True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class AddByUrlRequest(BaseModel):
    url: str


class ReorderRequest(BaseModel):
    ids: list[str]


@router.get("")
async def get_photos() -> list[dict[str, Any]]:
    return list_photos()


@router.post("")
async def upload_photo(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    try:
        return add_photo(data, file.content_type or "", file.filename, source_url=None)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/url")
async def add_photo_from_url(body: AddByUrlRequest) -> dict[str, Any]:
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "That doesn't look like a web address")

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_PHOTO_BYTES:
                        raise HTTPException(400, f"Image is larger than the {MAX_PHOTO_BYTES // (1024 * 1024)} MB limit")
                    chunks.append(chunk)
    except httpx.HTTPError as error:
        raise HTTPException(502, f"Could not fetch that URL: {error}") from error

    data = b"".join(chunks)
    original_name = url.rsplit("/", 1)[-1].split("?")[0] or None
    try:
        return add_photo(data, content_type, original_name, source_url=url)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@router.post("/order")
async def set_photo_order(body: ReorderRequest) -> list[dict[str, Any]]:
    return reorder_photos(body.ids)


@router.delete("/{photo_id}")
async def remove_photo(photo_id: str) -> dict[str, bool]:
    return {"deleted": delete_photo(photo_id)}


@router.get("/{photo_id}/file")
async def get_photo_file(photo_id: str) -> FileResponse:
    return _serve(photo_id, thumbnail=False)


@router.get("/{photo_id}/thumb")
async def get_photo_thumbnail(photo_id: str) -> FileResponse:
    # Falls back to the full image for anything added before thumbnails existed, so an older
    # library still renders rather than showing a grid of broken images.
    return _serve(photo_id, thumbnail=photo_file_path(photo_id, thumbnail=True) is not None)


def _serve(photo_id: str, thumbnail: bool) -> FileResponse:
    record = photo_record(photo_id)
    path = photo_file_path(photo_id, thumbnail=thumbnail)
    if not record or not path:
        raise HTTPException(404, "Photo not found")
    return FileResponse(path, media_type=record.get("contentType") or "application/octet-stream")
