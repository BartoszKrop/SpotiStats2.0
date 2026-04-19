from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

TOP_LIMIT = 10
# Python datetime.weekday() uses Monday=0 ... Sunday=6 (different from JS Date.getDay()).
WEEKDAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass(frozen=True)
class NormalizationReport:
    rows: list[dict[str, Any]]
    invalid_rows: int
    total_rows: int


def _parse_timestamp(value: str) -> datetime | None:
    if not value:
        return None
    candidate = value.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def normalize_history_rows_with_report(raw_rows: list[dict[str, Any]]) -> NormalizationReport:
    rows: list[dict[str, Any]] = []
    invalid = 0

    for row in raw_rows:
        timestamp = row.get("ts") or row.get("endTime") or row.get("end_time")
        artist = (
            row.get("master_metadata_album_artist_name")
            or row.get("artistName")
            or row.get("artist")
            or "Unknown artist"
        )
        track = row.get("master_metadata_track_name") or row.get("trackName") or row.get("track") or "Unknown track"
        album = (
            row.get("master_metadata_album_album_name")
            or row.get("albumName")
            or row.get("album")
            or "Unknown album"
        )

        try:
            ms_played = float(row.get("ms_played", row.get("msPlayed", 0)))
        except (TypeError, ValueError):
            ms_played = 0

        parsed = _parse_timestamp(str(timestamp) if timestamp is not None else "")
        if parsed is None or ms_played <= 0:
            invalid += 1
            continue

        rows.append(
            {
                "timestamp": parsed,
                "artist": artist,
                "track": track,
                "album": album,
                "ms_played": ms_played,
            }
        )

    return NormalizationReport(rows=rows, invalid_rows=invalid, total_rows=len(raw_rows))


def parse_genre_map(raw_data: Any) -> dict[str, list[str]]:
    if raw_data is None:
        return {}

    if isinstance(raw_data, dict):
        return {k: v for k, v in raw_data.items() if isinstance(k, str) and isinstance(v, list)}

    if isinstance(raw_data, list):
        out: dict[str, list[str]] = {}
        for item in raw_data:
            if isinstance(item, dict) and isinstance(item.get("artist"), str) and isinstance(item.get("genres"), list):
                out[item["artist"]] = item["genres"]
        return out

    return {}


def filter_by_range(
    entries: list[dict[str, Any]],
    range_key: str,
    now: datetime | None = None,
    custom_start: datetime | None = None,
    custom_end: datetime | None = None,
) -> list[dict[str, Any]]:
    now = now or datetime.now(timezone.utc)

    if range_key == "all":
        lower = None
        upper = now
    elif range_key == "4w":
        lower = now - timedelta(days=28)
        upper = now
    elif range_key == "12m":
        lower = now - timedelta(days=365)
        upper = now
    elif range_key == "last_year":
        lower = datetime(now.year - 1, 1, 1, tzinfo=timezone.utc)
        upper = datetime(now.year - 1, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
    elif range_key == "year":
        lower = datetime(now.year, 1, 1, tzinfo=timezone.utc)
        upper = now
    elif range_key == "6m":
        lower = now - timedelta(days=183)
        upper = now
    elif range_key == "3m":
        lower = now - timedelta(days=92)
        upper = now
    elif range_key == "1m":
        lower = now - timedelta(days=31)
        upper = now
    elif range_key == "1w":
        lower = now - timedelta(days=7)
        upper = now
    elif range_key == "today":
        lower = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        upper = now
    elif range_key == "custom":
        if custom_start is None or custom_end is None:
            return entries
        lower = custom_start
        upper = custom_end
    else:
        lower = None
        upper = now

    if lower is None:
        return entries

    return [entry for entry in entries if lower <= entry["timestamp"] <= upper]


def _top(counter: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    sorted_items = sorted(counter.items(), key=lambda x: (-x[1]["ms"], -x[1]["plays"], x[0]))
    out = []
    for label, value in sorted_items[:TOP_LIMIT]:
        out.append({"label": label, "plays": int(value["plays"]), "hours": round(value["ms"] / 3_600_000, 2)})
    return out


def _update(counter: dict[str, dict[str, float]], key: str, ms: float) -> None:
    if not key:
        return
    if key not in counter:
        counter[key] = {"plays": 0, "ms": 0.0}
    counter[key]["plays"] += 1
    counter[key]["ms"] += ms


def build_stats(entries: list[dict[str, Any]], genre_map: dict[str, list[str]]) -> dict[str, Any]:
    artist_counter: dict[str, dict[str, float]] = {}
    track_counter: dict[str, dict[str, float]] = {}
    album_counter: dict[str, dict[str, float]] = {}
    genre_counter: dict[str, dict[str, float]] = {}

    by_day = Counter()
    by_weekday = {day: 0.0 for day in WEEKDAY}
    by_hour = {hour: 0.0 for hour in range(24)}

    total_ms = 0.0

    for entry in entries:
        ms = entry["ms_played"]
        total_ms += ms

        _update(artist_counter, entry["artist"], ms)
        _update(track_counter, f"{entry['track']} — {entry['artist']}", ms)
        _update(album_counter, f"{entry['album']} — {entry['artist']}", ms)

        for genre in genre_map.get(entry["artist"], ["Unknown"]):
            _update(genre_counter, genre, ms)

        dt = entry["timestamp"]
        by_day[dt.date().isoformat()] += ms
        by_weekday[WEEKDAY[dt.weekday()]] += ms
        by_hour[dt.hour] += ms

    active_days = max(len(by_day), 1)

    return {
        "summary": {
            "total_plays": len(entries),
            "total_hours": round(total_ms / 3_600_000, 2),
            "avg_daily_minutes": round((total_ms / active_days) / 60_000, 1),
        },
        "top_artists": _top(artist_counter),
        "top_tracks": _top(track_counter),
        "top_albums": _top(album_counter),
        "top_genres": _top(genre_counter),
        "weekday_hours": [{"day": day, "hours": round(ms / 3_600_000, 2)} for day, ms in by_weekday.items()],
        "hourly_hours": [{"hour": hour, "hours": round(ms / 3_600_000, 2)} for hour, ms in by_hour.items()],
        "daily_hours": [{"date": date, "hours": round(ms / 3_600_000, 2)} for date, ms in sorted(by_day.items())],
        "history": [
            {
                "timestamp": entry["timestamp"].isoformat(),
                "artist": entry["artist"],
                "track": entry["track"],
                "album": entry["album"],
                "minutes": round(entry["ms_played"] / 60_000, 2),
            }
            for entry in sorted(entries, key=lambda row: row["timestamp"], reverse=True)
        ],
    }


def filter_history(
    entries: list[dict[str, Any]],
    artist_contains: str = "",
    album_contains: str = "",
    track_contains: str = "",
) -> list[dict[str, Any]]:
    artist_query = artist_contains.strip().lower()
    album_query = album_contains.strip().lower()
    track_query = track_contains.strip().lower()

    out = entries
    if artist_query:
        out = [entry for entry in out if artist_query in entry["artist"].lower()]
    if album_query:
        out = [entry for entry in out if album_query in entry["album"].lower()]
    if track_query:
        out = [entry for entry in out if track_query in entry["track"].lower()]
    return out
