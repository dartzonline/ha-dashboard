"""The photo library: add by upload or by URL, process, list, reorder, serve, delete.

Storage is redirected into `tmp_path` for every test (`isolated_photo_store` below) so nothing here
ever touches the real `/data` volume or a developer's actual photo library. The URL-add path is
exercised against a fake httpx client -- nothing here reaches the real network.

The processing tests build real images with Pillow rather than using fixture bytes, because what is
being asserted (an oversized photo is downscaled, a rotated one is straightened, alpha is flattened)
is only meaningful against an image with those actual properties.
"""

from __future__ import annotations

import io
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import photos
from app.main import app

client = TestClient(app)

def make_image(width=64, height=48, mode="RGB", fmt="JPEG", colour=(200, 80, 40), exif=None) -> bytes:
    """A real encoded image of a given size/mode, so size and orientation assertions mean something."""
    image = Image.new(mode, (width, height), colour if mode != "RGBA" else (*colour, 255))
    buffer = io.BytesIO()
    if exif is not None:
        image.save(buffer, format=fmt, exif=exif)
    else:
        image.save(buffer, format=fmt)
    return buffer.getvalue()


TINY_GIF = make_image(fmt="GIF", mode="P")
SMALL_JPEG = make_image()


@pytest.fixture(autouse=True)
def isolated_photo_store(tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "_data_dir", lambda: tmp_path)
    (tmp_path / "photos").mkdir(exist_ok=True)
    return tmp_path


def upload(filename="sunset.jpg", content_type="image/jpeg", data=None, source_url=None):
    data = SMALL_JPEG if data is None else data
    return photos.add_photo(data, content_type, filename, source_url)


class TestAddPhoto:
    def test_a_valid_image_is_stored_and_indexed(self):
        entry = upload()
        assert entry["id"].startswith("photo_")
        assert entry["originalName"] == "sunset.jpg"
        assert entry["contentType"] == "image/jpeg"
        assert entry["originalBytes"] == len(SMALL_JPEG)
        assert entry["sourceUrl"] is None
        assert photos.photo_file_path(entry["id"]) is not None
        assert photos.photo_file_path(entry["id"], thumbnail=True) is not None

    def test_the_index_persists_across_a_fresh_read(self):
        """`_load_index()` re-reads from disk every call -- this is what a restart looks like."""
        entry = upload()
        assert any(item["id"] == entry["id"] for item in photos._load_index())

    def test_an_oversized_image_is_refused(self, monkeypatch):
        monkeypatch.setattr(photos, "MAX_PHOTO_BYTES", 10)
        with pytest.raises(ValueError, match="larger than"):
            upload(data=TINY_GIF)

    def test_an_unsupported_content_type_is_refused(self):
        with pytest.raises(ValueError, match="Unsupported image type"):
            upload(content_type="application/pdf")

    def test_empty_data_is_refused(self):
        with pytest.raises(ValueError, match="empty"):
            upload(data=b"")

    def test_a_content_type_with_a_charset_suffix_is_still_recognised(self):
        # Some servers answer "image/jpeg; charset=binary"; the parameter must not defeat the match.
        entry = upload(content_type="image/jpeg; charset=binary")
        assert entry["contentType"] == "image/jpeg"

    def test_an_unsafe_filename_is_sanitised_rather_than_used_as_a_path(self):
        entry = upload(filename="../../etc/passwd.jpg")
        assert "/" not in entry["originalName"]
        assert ".." not in entry["originalName"]

    def test_a_missing_filename_is_survived(self):
        entry = upload(filename=None)
        assert entry["originalName"] is None

    def test_two_uploads_with_the_same_original_name_do_not_collide(self):
        first = upload(filename="photo.jpg")
        second = upload(filename="photo.jpg")
        assert first["storedName"] != second["storedName"]
        assert photos.photo_file_path(first["id"]) != photos.photo_file_path(second["id"])


class TestListPhotos:
    def test_photos_are_listed_in_the_order_they_were_added(self):
        first = upload(filename="first.jpg")
        second = upload(filename="second.jpg")
        assert [entry["id"] for entry in photos.list_photos()] == [first["id"], second["id"]]

    def test_each_new_photo_lands_at_the_end_of_the_running_order(self):
        positions = [upload(filename=f"{index}.jpg")["position"] for index in range(3)]
        assert positions == [0, 1, 2]

    def test_an_empty_library_is_an_empty_list(self):
        assert photos.list_photos() == []


class TestProcessImage:
    """The point of processing: what gets stored suits the panel, not whatever the phone produced."""

    def test_an_oversized_photo_is_downscaled_to_fit_the_panel(self):
        display, _, dimensions = photos.process_image(make_image(width=4000, height=3000))
        assert dimensions["originalWidth"] == 4000
        assert dimensions["width"] <= photos.DISPLAY_MAX_WIDTH
        assert dimensions["height"] <= photos.DISPLAY_MAX_HEIGHT
        assert Image.open(io.BytesIO(display)).size == (dimensions["width"], dimensions["height"])

    def test_downscaling_preserves_the_aspect_ratio(self):
        _, _, dimensions = photos.process_image(make_image(width=4000, height=3000))
        assert dimensions["width"] / dimensions["height"] == pytest.approx(4000 / 3000, rel=0.01)

    def test_a_photo_smaller_than_the_panel_is_never_blown_up(self):
        """Upscaling would add bytes and blur without adding any detail."""
        _, _, dimensions = photos.process_image(make_image(width=320, height=240))
        assert (dimensions["width"], dimensions["height"]) == (320, 240)

    def test_an_oversized_photo_gets_meaningfully_smaller(self):
        # A photorealistic gradient rather than a flat colour: a solid fill compresses to almost
        # nothing at any size, which would make this assertion pass without proving anything.
        original = Image.new("RGB", (4000, 3000))
        original.putdata([( (x * 7) % 256, (y * 5) % 256, (x + y) % 256 ) for y in range(3000) for x in range(4000)])
        buffer = io.BytesIO()
        original.save(buffer, format="JPEG", quality=95)
        raw = buffer.getvalue()

        display, _, _ = photos.process_image(raw)
        assert len(display) < len(raw)

    def test_a_thumbnail_is_produced_and_is_smaller_than_the_display_copy(self):
        display, thumbnail, _ = photos.process_image(make_image(width=4000, height=3000))
        assert len(thumbnail) < len(display)
        thumb_image = Image.open(io.BytesIO(thumbnail))
        assert max(thumb_image.size) <= photos.THUMBNAIL_MAX

    def test_a_rotated_photo_is_straightened_rather_than_served_sideways(self):
        # EXIF orientation 6 means "rotate 90° clockwise to display"; a phone writes portrait shots
        # this way, and an <img> that ignores the tag shows them on their side.
        exif = Image.Exif()
        exif[274] = 6
        landscape_with_rotate_tag = make_image(width=400, height=200, exif=exif)
        _, _, dimensions = photos.process_image(landscape_with_rotate_tag)
        # Stored upright: the 400x200 file is really a 200x400 portrait photo.
        assert (dimensions["width"], dimensions["height"]) == (200, 400)

    def test_a_transparent_png_is_flattened_rather_than_failing_to_encode(self):
        """JPEG has no alpha channel, so an unflattened RGBA image cannot be saved at all."""
        display, _, _ = photos.process_image(make_image(mode="RGBA", fmt="PNG"))
        assert Image.open(io.BytesIO(display)).mode == "RGB"

    def test_exif_metadata_does_not_survive_into_the_stored_copy(self):
        exif = Image.Exif()
        exif[274] = 1
        exif[271] = "SomePhoneMaker"
        processed, _, _ = photos.process_image(make_image(exif=exif))
        assert not Image.open(io.BytesIO(processed)).getexif()

    def test_a_file_that_is_not_an_image_is_refused_with_a_readable_message(self):
        with pytest.raises(ValueError, match="could not be read as an image"):
            photos.process_image(b"this is not an image")

    def test_a_truncated_image_is_refused_rather_than_stored_broken(self):
        with pytest.raises(ValueError, match="could not be read as an image"):
            photos.process_image(SMALL_JPEG[:20])


class TestReorderPhotos:
    def test_photos_are_reordered_to_the_given_sequence(self):
        first = upload(filename="a.jpg")
        second = upload(filename="b.jpg")
        third = upload(filename="c.jpg")

        photos.reorder_photos([third["id"], first["id"], second["id"]])
        assert [entry["id"] for entry in photos.list_photos()] == [third["id"], first["id"], second["id"]]

    def test_the_new_order_survives_a_fresh_read(self):
        first = upload(filename="a.jpg")
        second = upload(filename="b.jpg")
        photos.reorder_photos([second["id"], first["id"]])
        assert [entry["id"] for entry in photos.list_photos()] == [second["id"], first["id"]]

    def test_a_photo_left_out_of_the_order_is_kept_rather_than_dropped(self):
        """A reorder computed from a stale list must not delete whatever it did not know about."""
        first = upload(filename="a.jpg")
        second = upload(filename="b.jpg")
        missing = upload(filename="c.jpg")

        result = photos.reorder_photos([second["id"], first["id"]])
        assert [entry["id"] for entry in result] == [second["id"], first["id"], missing["id"]]

    def test_an_unknown_id_in_the_order_is_ignored(self):
        only = upload(filename="a.jpg")
        result = photos.reorder_photos(["photo_does_not_exist", only["id"]])
        assert [entry["id"] for entry in result] == [only["id"]]

    def test_reordering_an_empty_library_is_survived(self):
        assert photos.reorder_photos([]) == []


class TestReorderRoute:
    def test_the_api_applies_and_returns_the_new_order(self):
        first = client.post("/api/photos", files={"file": ("a.jpg", io.BytesIO(SMALL_JPEG), "image/jpeg")}).json()
        second = client.post("/api/photos", files={"file": ("b.jpg", io.BytesIO(SMALL_JPEG), "image/jpeg")}).json()

        response = client.post("/api/photos/order", json={"ids": [second["id"], first["id"]]})
        assert response.status_code == 200
        assert [entry["id"] for entry in response.json()] == [second["id"], first["id"]]
        assert [entry["id"] for entry in client.get("/api/photos").json()] == [second["id"], first["id"]]


class TestThumbnailRoute:
    def test_a_thumbnail_is_served_and_is_smaller_than_the_full_image(self):
        added = client.post(
            "/api/photos", files={"file": ("big.jpg", io.BytesIO(make_image(width=4000, height=3000)), "image/jpeg")},
        ).json()

        thumb = client.get(f"/api/photos/{added['id']}/thumb")
        full = client.get(f"/api/photos/{added['id']}/file")
        assert thumb.status_code == 200
        assert len(thumb.content) < len(full.content)
        assert max(Image.open(io.BytesIO(thumb.content)).size) <= photos.THUMBNAIL_MAX

    def test_an_older_photo_without_a_thumbnail_falls_back_to_the_full_image(self):
        """A library added before thumbnails existed must still render, not 404 into broken tiles."""
        entry = upload()
        entries = photos._load_index()
        for item in entries:
            (photos._photos_dir() / str(item.pop("thumbName"))).unlink()
        photos._save_index(entries)

        response = client.get(f"/api/photos/{entry['id']}/thumb")
        assert response.status_code == 200
        assert Image.open(io.BytesIO(response.content)).size == (64, 48)

    def test_an_unknown_id_is_a_404(self):
        assert client.get("/api/photos/photo_nope/thumb").status_code == 404


class TestDeletePhoto:
    def test_deleting_removes_the_file_and_the_index_entry(self):
        entry = upload()
        path = photos.photo_file_path(entry["id"])
        assert path is not None and path.is_file()

        assert photos.delete_photo(entry["id"]) is True
        assert photos.photo_file_path(entry["id"]) is None
        assert not path.is_file()

    def test_deleting_an_unknown_id_reports_false_rather_than_raising(self):
        assert photos.delete_photo("photo_does_not_exist") is False

    def test_deleting_one_photo_leaves_the_others(self):
        keep = upload(filename="keep.jpg")
        remove = upload(filename="remove.jpg")
        photos.delete_photo(remove["id"])
        assert [entry["id"] for entry in photos.list_photos()] == [keep["id"]]


class TestPhotoFilePath:
    def test_an_unknown_id_resolves_to_nothing(self):
        assert photos.photo_file_path("photo_nope") is None

    def test_an_index_entry_whose_file_went_missing_resolves_to_nothing(self):
        entry = upload()
        photos.photo_file_path(entry["id"]).unlink()
        assert photos.photo_file_path(entry["id"]) is None


class TestUploadRoute:
    def test_uploading_a_file_returns_the_new_record(self):
        response = client.post(
            "/api/photos", files={"file": ("sunset.jpg", io.BytesIO(TINY_GIF), "image/jpeg")},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["originalName"] == "sunset.jpg"
        assert body["id"] in [item["id"] for item in client.get("/api/photos").json()]

    def test_uploading_an_unsupported_type_is_a_400(self):
        response = client.post(
            "/api/photos", files={"file": ("doc.pdf", io.BytesIO(b"%PDF-"), "application/pdf")},
        )
        assert response.status_code == 400


class TestPhotoFileRoute:
    def test_the_stored_bytes_come_back_with_the_right_content_type(self):
        added = client.post(
            "/api/photos", files={"file": ("sunset.jpg", io.BytesIO(TINY_GIF), "image/jpeg")},
        ).json()
        response = client.get(f"/api/photos/{added['id']}/file")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/jpeg"
        # Re-encoded on the way in, so this is deliberately not a byte-for-byte comparison with
        # what was uploaded -- what matters is that a real, decodable image comes back.
        assert Image.open(io.BytesIO(response.content)).size == (64, 48)

    def test_an_unknown_id_is_a_404(self):
        assert client.get("/api/photos/photo_nope/file").status_code == 404


class TestDeleteRoute:
    def test_deleting_through_the_api_removes_it_from_the_list(self):
        added = client.post(
            "/api/photos", files={"file": ("sunset.jpg", io.BytesIO(TINY_GIF), "image/jpeg")},
        ).json()
        response = client.delete(f"/api/photos/{added['id']}")
        assert response.json() == {"deleted": True}
        assert added["id"] not in [item["id"] for item in client.get("/api/photos").json()]

    def test_deleting_twice_the_second_time_reports_false(self):
        added = client.post(
            "/api/photos", files={"file": ("sunset.jpg", io.BytesIO(TINY_GIF), "image/jpeg")},
        ).json()
        client.delete(f"/api/photos/{added['id']}")
        response = client.delete(f"/api/photos/{added['id']}")
        assert response.json() == {"deleted": False}


class TestAddByUrl:
    def test_a_non_http_url_is_rejected_before_any_fetch_is_attempted(self):
        response = client.post("/api/photos/url", json={"url": "not-a-url"})
        assert response.status_code == 400

    def test_a_fetched_image_is_stored_like_an_upload(self, monkeypatch):
        monkeypatch.setattr(photos.httpx, "AsyncClient", lambda **kwargs: _FakeAsyncClient(TINY_GIF, "image/jpeg"))
        response = client.post("/api/photos/url", json={"url": "https://example.com/pic.jpg"})
        assert response.status_code == 200
        body = response.json()
        assert body["sourceUrl"] == "https://example.com/pic.jpg"
        assert body["contentType"] == "image/jpeg"

    def test_an_oversized_fetch_is_rejected_mid_stream_rather_than_fully_buffered(self, monkeypatch):
        monkeypatch.setattr(photos, "MAX_PHOTO_BYTES", 4)
        monkeypatch.setattr(photos.httpx, "AsyncClient", lambda **kwargs: _FakeAsyncClient(TINY_GIF, "image/jpeg"))
        response = client.post("/api/photos/url", json={"url": "https://example.com/pic.jpg"})
        assert response.status_code == 400

    def test_an_unreachable_url_is_reported_rather_than_crashing(self, monkeypatch):
        monkeypatch.setattr(photos.httpx, "AsyncClient", lambda **kwargs: _FailingAsyncClient())
        response = client.post("/api/photos/url", json={"url": "https://example.com/pic.jpg"})
        assert response.status_code == 502


class _FakeStreamResponse:
    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self.headers = {"content-type": content_type}

    def raise_for_status(self) -> None:
        return None

    async def aiter_bytes(self):
        # Chunked, not one blob, so a mid-stream size check actually gets exercised.
        for start in range(0, len(self._data), 2):
            yield self._data[start:start + 2]

    async def __aenter__(self) -> "_FakeStreamResponse":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        return None


class _FakeAsyncClient:
    def __init__(self, data: bytes, content_type: str):
        self._data = data
        self._content_type = content_type

    def stream(self, method: str, url: str) -> _FakeStreamResponse:
        return _FakeStreamResponse(self._data, self._content_type)

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        return None


class _FailingAsyncClient:
    def stream(self, method: str, url: str):
        raise httpx.ConnectError("boom")

    async def __aenter__(self) -> "_FailingAsyncClient":
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        return None
