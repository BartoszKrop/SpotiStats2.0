from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import streamlit as st

from streamlit_core import build_stats, filter_by_range, normalize_history_rows_with_report, parse_genre_map

RANGES = {
    "All time": "all",
    "Last 12 months": "12m",
    "Current year": "year",
    "Last 6 months": "6m",
    "Last 3 months": "3m",
    "Last 1 month": "1m",
    "Last 1 week": "1w",
    "Today": "today",
}

CACHE_DIR = Path(".streamlit-cache")
CACHE_DIR.mkdir(exist_ok=True)

st.set_page_config(page_title="SpotiStats 2.0 Streamlit", layout="wide")
st.title("SpotiStats 2.0 — Streamlit MVP")
st.caption("Test dashboard inspired by stats.fm workflows for rapid product iteration.")


@st.cache_data(show_spinner=False)
def parse_history_payload(payloads: list[str]) -> dict[str, Any]:
    raw_rows: list[dict[str, Any]] = []
    parse_errors = 0

    for payload in payloads:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            parse_errors += 1
            continue

        if not isinstance(parsed, list):
            parse_errors += 1
            continue

        raw_rows.extend(parsed)

    report = normalize_history_rows_with_report(raw_rows)
    return {
        "rows": report.rows,
        "invalid_rows": report.invalid_rows,
        "total_rows": report.total_rows,
        "parse_errors": parse_errors,
    }


@st.cache_data(show_spinner=False)
def parse_genres_payload(payload: str | None) -> dict[str, list[str]]:
    if not payload:
        return {}
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    return parse_genre_map(parsed)


@st.cache_data(show_spinner=False)
def compute_stats(rows: list[dict[str, Any]], genres: dict[str, list[str]], range_key: str) -> dict[str, Any]:
    return build_stats(filter_by_range(rows, range_key), genres)


with st.sidebar:
    st.header("Data source")
    history_files = st.file_uploader(
        "Spotify Extended Streaming History JSON files",
        type=["json"],
        accept_multiple_files=True,
    )
    genre_file = st.file_uploader("Optional artist genre map JSON", type=["json"])
    selected_range_label = st.selectbox("Time range", options=list(RANGES.keys()), index=0)

if not history_files:
    st.info("Upload at least one listening history JSON file to start.")
    st.stop()

history_payloads = [file.getvalue().decode("utf-8", errors="ignore") for file in history_files]
parsed_history = parse_history_payload(history_payloads)

if parsed_history["rows"]:
    cache_path = CACHE_DIR / "last_rows_count.txt"
    cache_path.write_text(str(len(parsed_history["rows"])), encoding="utf-8")

genre_payload = genre_file.getvalue().decode("utf-8", errors="ignore") if genre_file else None
genre_map = parse_genres_payload(genre_payload)

if genre_file and not genre_map:
    st.warning("Genre file could not be parsed (or has unsupported schema).")

stats = compute_stats(parsed_history["rows"], genre_map, RANGES[selected_range_label])

st.success(
    f"Loaded {len(parsed_history['rows'])} events from {parsed_history['total_rows']} rows. "
    f"Skipped rows: {parsed_history['invalid_rows']}. File parse issues: {parsed_history['parse_errors']}."
)

col1, col2, col3 = st.columns(3)
col1.metric("Total plays", stats["summary"]["total_plays"])
col2.metric("Total listening hours", stats["summary"]["total_hours"])
col3.metric("Avg daily listening (min)", stats["summary"]["avg_daily_minutes"])

left, right = st.columns(2)

with left:
    st.subheader("Top artists")
    st.table(stats["top_artists"])
    st.subheader("Top tracks")
    st.table(stats["top_tracks"])

with right:
    st.subheader("Top albums")
    st.table(stats["top_albums"])
    st.subheader("Top genres")
    st.table(stats["top_genres"])

pattern_left, pattern_right = st.columns(2)
with pattern_left:
    st.subheader("Listening by weekday")
    st.bar_chart({row["day"]: row["hours"] for row in stats["weekday_hours"]})

with pattern_right:
    st.subheader("Listening by hour")
    st.bar_chart({f"{row['hour']:02d}:00": row["hours"] for row in stats["hourly_hours"]})
