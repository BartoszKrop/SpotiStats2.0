from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import streamlit as st

from spotify_oauth import build_authorize_url, create_pkce_session, exchange_code_for_token, refresh_access_token
from streamlit_core import (
    build_stats,
    filter_by_range,
    filter_history,
    normalize_history_rows_with_report,
    parse_genre_map,
)

RANGES = {
    "All time": "all",
    "Last 4 weeks": "4w",
    "Last 12 months": "12m",
    "Last year": "last_year",
    "Current year": "year",
    "Last 6 months": "6m",
    "Last 3 months": "3m",
    "Last 1 month": "1m",
    "Last 1 week": "1w",
    "Today": "today",
    "Custom range": "custom",
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
def compute_stats(
    rows: list[dict[str, Any]],
    genres: dict[str, list[str]],
    range_key: str,
    custom_start_iso: str | None = None,
    custom_end_iso: str | None = None,
) -> dict[str, Any]:
    custom_start = None
    custom_end = None
    if custom_start_iso and custom_end_iso:
        custom_start = datetime.fromisoformat(custom_start_iso)
        custom_end = datetime.fromisoformat(custom_end_iso)
    return build_stats(filter_by_range(rows, range_key, custom_start=custom_start, custom_end=custom_end), genres)


with st.sidebar:
    st.header("Data source")
    history_files = st.file_uploader(
        "Spotify Extended Streaming History JSON files",
        type=["json"],
        accept_multiple_files=True,
    )
    genre_file = st.file_uploader("Optional artist genre map JSON", type=["json"])
    selected_range_label = st.selectbox("Time range", options=list(RANGES.keys()), index=0)
    custom_start = None
    custom_end = None
    if RANGES[selected_range_label] == "custom":
        st.caption("Custom range (UTC)")
        custom_start = st.date_input("Start date")
        custom_end = st.date_input("End date")

    st.divider()
    st.subheader("Spotify account (MVP)")
    client_id = st.text_input("Spotify Client ID", value=st.secrets.get("SPOTIFY_CLIENT_ID", ""))
    redirect_uri = st.text_input("Redirect URI", value=st.secrets.get("SPOTIFY_REDIRECT_URI", "http://localhost:8501"))
    if "pkce" not in st.session_state:
        st.session_state.pkce = create_pkce_session()

    scopes = [
        "user-read-recently-played",
        "user-read-currently-playing",
        "user-top-read",
        "playlist-modify-public",
        "playlist-modify-private",
    ]
    if client_id and redirect_uri:
        auth_url = build_authorize_url(client_id, redirect_uri, scopes, st.session_state.pkce)
        st.link_button("Connect Spotify account", auth_url)

    query_params = st.query_params
    auth_code = query_params.get("code")
    callback_state = query_params.get("state")
    if client_id and redirect_uri and auth_code and callback_state == st.session_state.pkce.state:
        if st.button("Finish Spotify authorization"):
            try:
                token = exchange_code_for_token(
                    client_id=client_id,
                    code=auth_code,
                    redirect_uri=redirect_uri,
                    verifier=st.session_state.pkce.verifier,
                )
                st.session_state.spotify_token = token
                st.success("Spotify connected.")
            except Exception as error:
                st.error(f"Spotify authorization failed: {error}")

    if st.session_state.get("spotify_token", {}).get("refresh_token"):
        if st.button("Refresh Spotify token"):
            try:
                refreshed = refresh_access_token(client_id, st.session_state.spotify_token["refresh_token"])
                st.session_state.spotify_token.update(refreshed)
                st.success("Token refreshed.")
            except Exception as error:
                st.error(f"Token refresh failed: {error}")

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

custom_start_iso = None
custom_end_iso = None
if custom_start and custom_end:
    custom_start_iso = f"{custom_start.isoformat()}T00:00:00+00:00"
    custom_end_iso = f"{custom_end.isoformat()}T23:59:59+00:00"

stats = compute_stats(parsed_history["rows"], genre_map, RANGES[selected_range_label], custom_start_iso, custom_end_iso)

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
    st.subheader("Listening trend (day by day)")
    st.line_chart({row["date"]: row["hours"] for row in stats["daily_hours"]})

with pattern_right:
    st.subheader("Listening by hour")
    st.bar_chart({f"{row['hour']:02d}:00": row["hours"] for row in stats["hourly_hours"]})

st.subheader("History timeline & filters")
artist_filter = st.text_input("Filter by artist")
album_filter = st.text_input("Filter by album")
track_filter = st.text_input("Filter by track")

filtered_history_entries = filter_history(
    filter_by_range(
        parsed_history["rows"],
        RANGES[selected_range_label],
        custom_start=datetime.fromisoformat(custom_start_iso) if custom_start_iso else None,
        custom_end=datetime.fromisoformat(custom_end_iso) if custom_end_iso else None,
    ),
    artist_contains=artist_filter,
    album_contains=album_filter,
    track_contains=track_filter,
)
filtered_history_stats = build_stats(filtered_history_entries, genre_map)
st.caption(f"History rows after filters: {len(filtered_history_stats['history'])}")
st.dataframe(filtered_history_stats["history"][:1000], use_container_width=True, hide_index=True)
