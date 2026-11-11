"""Where the add-on keeps its files: Home Assistant's `/data` volume, or `backend/data` in development."""

from pathlib import Path


def data_file(name: str) -> Path:
    data_dir = Path("/data")
    if data_dir.is_dir():
        return data_dir / name
    fallback_dir = Path(__file__).resolve().parents[1] / "data"
    fallback_dir.mkdir(parents=True, exist_ok=True)
    return fallback_dir / name
