"""Personal photo library: add pictures by upload or by URL, list them, reorder them, delete them.

This module is deliberately just the library -- storing, processing, listing, serving and removing
images. Where and how photos get *displayed* on the wall panel is a separate decision; nothing here
assumes a particular display surface, so that choice can change without touching storage.

Files live under the same persistent-volume convention as everything else that has to survive a
restart (`dashboard_config.py`, `flight_sources.Budget`): `/data` when running as the Home Assistant
add-on, a repo-local `backend/data/` fallback otherwise. A small JSON index sits alongside the image
files themselves and is the source of truth for metadata; the files are named by id, not by the
original filename, so two uploads called "photo.jpg" never collide. Should the index ever be lost or
corrupted, it is rebuilt from the files -- the library's photos are never the thing that goes
missing, only the metadata about them.

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

The decoding and re-encoding is CPU work measured in hundreds of milliseconds per photo, so the
routes hand it to a worker thread: the event loop that is also streaming Home Assistant events to
every browser must not stall while a batch of holiday photos is being added.
"""

from __future__ import annotations

import asyncio
import io
import ipaddress
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .atomic import write_text_atomic

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/photos")

# Generous enough for an ordinary phone photo, bounded so one add can't fill the disk. This is the
# limit on what is *accepted*; what gets stored is far smaller after processing.
MAX_PHOTO_BYTES = 20 * 1024 * 1024

# A decompression bomb is a tiny file that decodes to an enormous bitmap: a 50 KB PNG can declare
# itself 30000x30000 and cost 2.7 GB of RAM to open. The byte limit above cannot catch that; this
# pixel limit does. 40 megapixels is above any phone camera in normal use (most are 12-50 MP, and
# 50 MP sensors bin to 12 MP by default), so real photos pass and only the pathological ones fail.
MAX_PHOTO_PIXELS = 40_000_000

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

# Stored files are named by a fresh id and never rewritten, so a browser may cache them forever;
# a changed photo is a new id. Thumbnails share the id, so they get the same treatment.
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

_FILENAME_UNSAFE = re.compile(r"[^A-Za-z0-9 ._-]")

# How many redirects an add-by-URL will follow. Each hop is re-checked against the private-address
# filter below, because "public URL that 302s to http://supervisor/..." is the classic way around a
# filter that only looks at the address the user typed.
MAX_URL_REDIRECTS = 3

# Hostnames that mean "this machine" or "Home Assistant" inside an add-on container regardless of
# what they resolve to. The backend holds a Supervisor token; a photo-frame URL must never be a way
# to point the backend at the Supervisor API.
BLOCKED_HOSTNAMES = frozenset({"supervisor", "homeassistant", "hassio", "localhost"})

# Carrier-grade NAT (RFC 6598) is not covered by `ip_address(...).is_private` on every Python
# version, and it is exactly the range a home ISP's CPE may sit in.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


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


# ---------------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------------

def _load_index() -> list[dict[str, Any]]:
    path = _index_path()
    if path.is_file():
        try:
            payload = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            logger.warning("photos index unreadable, rebuilding from files: %s", error)
        else:
            if isinstance(payload, list):
                return payload
            logger.warning("photos index was not a list, rebuilding from files")
    return _rebuild_index_from_files()


def _rebuild_index_from_files() -> list[dict[str, Any]]:
    """Best-effort index from whatever stored files exist.

    Only the metadata (original name, source URL, original size) is lost when the index is; the
    photos themselves are all named `<id>.jpg` with `<id>_thumb.jpg` beside them, which is enough to
    keep the library on the wall. Returns `[]` -- and writes nothing -- when there are no files, so
    an empty library still costs no index file.
    """
    photos_dir = _photos_dir()
    entries: list[dict[str, Any]] = []
    for path in sorted(photos_dir.glob(f"*.{STORED_EXTENSION}"), key=lambda item: item.stat().st_mtime):
        if path.stem.endswith("_thumb"):
            continue
        thumb = photos_dir / f"{path.stem}_thumb.{STORED_EXTENSION}"
        dimensions: dict[str, Any] = {}
        try:
            with Image.open(path) as image:
                dimensions = {"width": image.width, "height": image.height}
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
            continue
        stat = path.stat()
        entries.append({
            "id": path.stem,
            "storedName": path.name,
            "thumbName": thumb.name if thumb.is_file() else None,
            "originalName": None,
            "contentType": STORED_CONTENT_TYPE,
            "sizeBytes": stat.st_size,
            "thumbBytes": thumb.stat().st_size if thumb.is_file() else None,
            "originalBytes": None,
            **dimensions,
            "addedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
            "sourceUrl": None,
            "position": len(entries),
            "recovered": True,
        })
    if entries:
        logger.warning("rebuilt photos index from %d file(s)", len(entries))
        _save_index(entries)
    return entries


def _save_index(entries: list[dict[str, Any]]) -> None:
    try:
        # Atomic: a torn write would be read back as "unreadable" and trigger a rebuild that
        # loses every original filename and source URL in the library.
        write_text_atomic(_index_path(), json.dumps(entries, indent=2))
    except OSError as error:
        logger.warning("could not persist photos index: %s", error)


# Serialises every read-modify-write of the index. Adds run partly in worker threads now, so two
# uploads arriving together could otherwise both read N entries and both write N+1, losing one.
# Created lazily because a module-level asyncio primitive would be built before any event loop.
_index_lock: asyncio.Lock | None = None


def _get_index_lock() -> asyncio.Lock:
    global _index_lock
    if _index_lock is None:
        _index_lock = asyncio.Lock()
    return _index_lock


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


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------

# Tried in order when the first encode comes out bigger than the file that was uploaded. An image
# that arrived already heavily compressed can cost *more* to re-encode at the default quality than
# it did to store originally, which would make "compress on the way in" quietly inflate a library.
#
# This gets the common case right rather than promising the impossible: a normal photograph that
# arrived over-compressed lands within budget one or two rungs down. A pathological one (dense
# high-frequency noise, saved at a quality below anything worth keeping) cannot be beaten without
# going below the source's own quality, so the floor wins and the file grows slightly -- which is
# the right trade against visibly degrading every real photo to cover that case.
QUALITY_LADDER = (88, 80, 72, 65)


class PhotoTooLarge(ValueError):
    """Distinct from a generic decode failure so the friendly message survives the except below."""


def _encode_at(image: Image.Image, quality: int) -> bytes:
    buffer = io.BytesIO()
    # optimize + progressive are free at display time and meaningfully smaller on disk; no EXIF is
    # passed through, so the GPS coordinates a phone attaches never reach the panel.
    image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue()


def _encode(image: Image.Image, box: tuple[int, int], quality: int, budget: int | None = None) -> tuple[bytes, int, int]:
    """Fit `image` inside `box` and encode it as JPEG. Returns (bytes, width, height).

    Only ever shrinks: `ImageOps.contain` scales in both directions, so it is guarded here rather
    than called unconditionally. Enlarging a photo that is already smaller than the panel would add
    bytes and blur to a picture without adding any detail to it.

    `budget` is the size this must not exceed -- the original upload's size. When the first attempt
    misses it, quality steps down until it fits or the ladder runs out, and the smallest attempt
    wins. Re-encoding still happens either way, because it is what bakes in the rotation and drops
    the metadata; this only decides how hard it compresses while doing so.
    """
    fitted = image
    if image.width > box[0] or image.height > box[1]:
        fitted = ImageOps.contain(image, box, Image.LANCZOS)

    best = _encode_at(fitted, quality)
    if budget is not None and len(best) > budget:
        for lower in (step for step in QUALITY_LADDER if step < quality):
            candidate = _encode_at(fitted, lower)
            if len(candidate) < len(best):
                best = candidate
            if len(best) <= budget:
                break

    return best, fitted.width, fitted.height


def process_image(data: bytes) -> tuple[bytes, bytes, dict[str, Any]]:
    """(display bytes, thumbnail bytes, dimensions) for one uploaded image.

    Raises ValueError for anything Pillow cannot decode, which covers both a corrupt file and a
    non-image that arrived with an image content-type, and for an image whose declared size would
    take an unreasonable amount of memory to decode.
    """
    try:
        with Image.open(io.BytesIO(data)) as opened:
            # `Image.open` reads only the header, so this is checked before any pixel is decoded
            # -- the whole point is to refuse *before* paying the memory.
            if opened.width * opened.height > MAX_PHOTO_PIXELS:
                raise PhotoTooLarge(
                    f"That image is {opened.width}x{opened.height}, more than the {MAX_PHOTO_PIXELS // 1_000_000} megapixel limit"
                )
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
            display, width, height = _encode(
                upright, (DISPLAY_MAX_WIDTH, DISPLAY_MAX_HEIGHT), DISPLAY_QUALITY, budget=len(data),
            )
            # No budget on the thumbnail: it is a fraction of the size of anything it comes from,
            # so it can never be the thing that inflates a library.
            thumbnail, _, _ = _encode(upright, (THUMBNAIL_MAX, THUMBNAIL_MAX), THUMBNAIL_QUALITY)
    except PhotoTooLarge:
        raise
    except Image.DecompressionBombError as error:
        # Pillow's own guard, for an image so large it trips before the check above runs.
        raise PhotoTooLarge("That image is far too large to process") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise ValueError("That file could not be read as an image") from error

    return display, thumbnail, {
        "width": width,
        "height": height,
        "originalWidth": original_width,
        "originalHeight": original_height,
    }


def prepare_photo(data: bytes, content_type: str) -> tuple[bytes, bytes, dict[str, Any]]:
    """The validate-and-process half of adding a photo: everything that needs no index access.

    Split from `store_photo` so the routes can run this (the slow, CPU-bound half) outside the index
    lock and only serialise the short file-and-index write that follows.
    """
    if not data:
        raise ValueError("The image was empty")
    if len(data) > MAX_PHOTO_BYTES:
        raise ValueError(f"Image is larger than the {MAX_PHOTO_BYTES // (1024 * 1024)} MB limit")
    if content_type.split(";")[0].strip().lower() not in ALLOWED_CONTENT_TYPES:
        raise ValueError(f"Unsupported image type: {content_type or 'unknown'}")
    return process_image(data)


def store_photo(
    processed: tuple[bytes, bytes, dict[str, Any]],
    original_bytes: int,
    original_name: str | None,
    source_url: str | None,
) -> dict[str, Any]:
    """Writes the files and records the entry in the index. Returns the new entry."""
    display, thumbnail, dimensions = processed
    # Index first, files second: `_load_index` rebuilds a missing index from the files on disk,
    # so writing this photo's files before reading the index would have it counted twice on the
    # very first add to an empty library.
    entries = _load_index()
    photo_id = f"photo_{uuid.uuid4().hex}"
    stored_name = f"{photo_id}.{STORED_EXTENSION}"
    thumb_name = f"{photo_id}_thumb.{STORED_EXTENSION}"
    (_photos_dir() / stored_name).write_bytes(display)
    (_photos_dir() / thumb_name).write_bytes(thumbnail)

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
        "originalBytes": original_bytes,
        **dimensions,
        "addedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceUrl": source_url,
        # Appended to the end of the running order; the manage screen can move it afterwards.
        "position": max((int(item.get("position", 0)) for item in entries), default=-1) + 1,
    }
    entries.append(entry)
    _save_index(entries)
    return entry


def add_photo(data: bytes, content_type: str, original_name: str | None, source_url: str | None) -> dict[str, Any]:
    """Validates, processes, writes the files, records it in the index, and returns the new entry.

    Raises ValueError with a message safe to show the person adding the photo -- the callers below
    turn that straight into the HTTP error, so it has to already read like an explanation, not a
    stack trace. Synchronous convenience over `prepare_photo` + `store_photo`; the routes call
    those two separately so only the second runs under the index lock.
    """
    return store_photo(prepare_photo(data, content_type), len(data), original_name, source_url)


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
# Fetching by URL
# ---------------------------------------------------------------------------

_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    """One client for every add-by-URL, so the connection pool is reused rather than rebuilt per
    request. Redirects are handled by hand in `_fetch_url` so each hop can be re-checked."""
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(follow_redirects=False, timeout=20, trust_env=False)
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


async def _resolve_host(host: str) -> list[str]:
    """Every address `host` resolves to (a literal IP resolves to itself)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, None)
    return sorted({str(info[4][0]) for info in infos})


def _address_is_private(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])  # strip an IPv6 scope id
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
        or (ip.version == 4 and ip in _CGNAT)
        or (ip.version == 6 and ip.ipv4_mapped is not None and _address_is_private(str(ip.ipv4_mapped)))
    )


async def _check_url_is_public(url: str) -> None:
    """Refuses any URL whose host is this machine, Home Assistant, or anything on a private network.

    The backend sits inside the home network with a Supervisor token in hand. Without this, "add a
    photo from a URL" would double as "make the backend fetch any LAN address and hand me the
    bytes" -- router admin pages, camera streams, the Supervisor API. Resolution happens here, at
    request time, so a public hostname that resolves to a private address is caught too.
    """
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise HTTPException(400, "That doesn't look like a web address")
    host = (parts.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise HTTPException(400, "That doesn't look like a web address")
    if host in BLOCKED_HOSTNAMES or host.endswith(".local") or host.endswith(".internal"):
        raise HTTPException(400, "Photos can only be added from public web addresses")
    try:
        # A literal address needs no lookup -- and must not get one, since a resolver could be
        # coaxed into answering differently for it than the socket layer will.
        addresses = [str(ipaddress.ip_address(host.strip("[]")))]
    except ValueError:
        try:
            addresses = await _resolve_host(host)
        except (OSError, ValueError):
            raise HTTPException(400, "That web address could not be found") from None
    if not addresses or any(_address_is_private(address) for address in addresses):
        raise HTTPException(400, "Photos can only be added from public web addresses")


async def _fetch_url(url: str) -> tuple[bytes, str, str]:
    """(bytes, content-type, final url) for a public URL, following a few redirects by hand.

    Each hop goes back through the public-address check: the address the person typed being public
    says nothing about where it redirects to. The body is bounded while streaming so an oversized
    or endless response is abandoned rather than buffered.
    """
    client = _get_http_client()
    current = url
    for _ in range(MAX_URL_REDIRECTS + 1):
        await _check_url_is_public(current)
        async with client.stream("GET", current) as response:
            if response.status_code in (301, 302, 303, 307, 308) and response.headers.get("location"):
                current = urljoin(current, response.headers["location"])
                continue
            response.raise_for_status()
            content_type = response.headers.get("content-type", "")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > MAX_PHOTO_BYTES:
                    raise HTTPException(400, f"Image is larger than the {MAX_PHOTO_BYTES // (1024 * 1024)} MB limit")
                chunks.append(chunk)
            return b"".join(chunks), content_type, current
    raise HTTPException(400, "That web address redirected too many times")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class AddByUrlRequest(BaseModel):
    url: str


class ReorderRequest(BaseModel):
    ids: list[str]


async def _add_photo_async(data: bytes, content_type: str, original_name: str | None, source_url: str | None) -> dict[str, Any]:
    """`add_photo`, arranged for the event loop: the decode/encode runs in a worker thread without
    holding the index lock; only the brief file-and-index write is serialised."""
    try:
        processed = await run_in_threadpool(prepare_photo, data, content_type)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    async with _get_index_lock():
        return await run_in_threadpool(store_photo, processed, len(data), original_name, source_url)


@router.get("")
async def get_photos() -> list[dict[str, Any]]:
    return list_photos()


@router.post("")
async def upload_photo(file: UploadFile = File(...)) -> dict[str, Any]:
    too_large = HTTPException(400, f"Image is larger than the {MAX_PHOTO_BYTES // (1024 * 1024)} MB limit")
    # Starlette knows the size up front for multipart uploads; refusing here spares reading a
    # 200 MB file into memory just to reject it afterwards. The running total below covers the
    # case where it does not.
    if file.size is not None and file.size > MAX_PHOTO_BYTES:
        raise too_large
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_PHOTO_BYTES:
            raise too_large
        chunks.append(chunk)
    return await _add_photo_async(b"".join(chunks), file.content_type or "", file.filename, source_url=None)


@router.post("/url")
async def add_photo_from_url(body: AddByUrlRequest) -> dict[str, Any]:
    url = body.url.strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(400, "That doesn't look like a web address")

    try:
        data, content_type, final_url = await _fetch_url(url)
    except httpx.HTTPError as error:
        # The exception text can carry the resolved address and the full redirect target -- exactly
        # the details the address filter exists to keep out of a response body. Logged for the
        # operator; the person at the panel gets a plain answer.
        logger.warning("add-by-URL fetch failed for %s: %s", url, error)
        raise HTTPException(502, "Could not fetch that image") from error

    original_name = final_url.rsplit("/", 1)[-1].split("?")[0] or None
    return await _add_photo_async(data, content_type, original_name, source_url=url)


@router.post("/order")
async def set_photo_order(body: ReorderRequest) -> list[dict[str, Any]]:
    async with _get_index_lock():
        return await run_in_threadpool(reorder_photos, body.ids)


@router.delete("/{photo_id}")
async def remove_photo(photo_id: str) -> dict[str, bool]:
    async with _get_index_lock():
        return {"deleted": await run_in_threadpool(delete_photo, photo_id)}


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
    return FileResponse(
        path,
        media_type=record.get("contentType") or "application/octet-stream",
        headers={"Cache-Control": IMMUTABLE_CACHE_CONTROL},
    )
