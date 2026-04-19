# SpotiStats2.0

SpotiStats 2.0 is a lightweight self-hosted stats.fm-style dashboard for Spotify history exports.

## Features

- Import one or many Spotify JSON listening history files
- Optional genre enrichment through an artist→genres JSON map
- Time ranges:
  - all time
  - last 12 months
  - current year
  - last 6 months
  - last 3 months
  - last month
  - last week
  - today
- Top lists for:
  - artists
  - songs
  - albums
  - genres
- Listening insights:
  - total plays and total listening time
  - average daily listening time
  - listening distribution by weekday
  - listening distribution by hour

## Run locally

Open `index.html` in a browser.

### Streamlit MVP (test mode)

Install dependencies:

```bash
pip install -r requirements-streamlit.txt
```

Run:

```bash
streamlit run streamlit_app.py
```

The Streamlit version includes:

- upload of multiple Spotify history JSON files
- optional genres map import
- ranges: all-time, 4 weeks, 12 months, last year, YTD, 6m, 3m, 1m, 1w, today, custom range
- top artists / tracks / albums / genres
- daily trend chart + weekday/hour activity charts
- history timeline with artist/album/track filters
- Spotify OAuth PKCE connection MVP (`spotify_oauth.py`)

### Spotify OAuth setup (optional)

In your Spotify app dashboard, configure redirect URI (for local Streamlit typically `http://localhost:8501`), then pass values in UI fields or Streamlit secrets:

```toml
# .streamlit/secrets.toml
SPOTIFY_CLIENT_ID = "your_client_id"
SPOTIFY_REDIRECT_URI = "http://localhost:8501"
```

## Genre map format (optional)

You can provide a second JSON file in one of these formats:

```json
{
  "Artist Name": ["pop", "dance"]
}
```

or

```json
[
  { "artist": "Artist Name", "genres": ["pop", "dance"] }
]
```

## Tests

Run:

```bash
node --test analytics.test.js
```

## Product roadmap and parity checklist

See `/docs/statsfm-feature-parity.md` for the current stats.fm-inspired feature matrix and implementation status.

## Suggested long-term architectures

- **FastAPI + Next.js** for production-grade multi-user app
- **Supabase + Next.js** for rapid cloud deployment with auth and storage
- **Tauri/Electron** for privacy-first local desktop analytics
