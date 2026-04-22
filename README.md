# SpotiStats2.0

SpotiStats 2.0 is a lightweight self-hosted stats.fm-style dashboard for Spotify history exports.

## Features

- New onboarding flow with local account auth screen (register / login) and separate dashboard view
- Local-only account storage (username + salted/hashed password) in browser storage
- Session persistence after refresh and explicit logout
- Import Spotify history from:
  - one or many JSON files
  - ZIP archives containing multiple JSON files (including multi-year exports)
- Automatic normalization + merge of imported rows with parsing/skip reporting
- Persistent local storage per user for imported history, genre map, source state, and selected time range
- Clear local user data action
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

## Local login flow

1. Open app and choose **Logowanie** or **Rejestracja**.
2. Create a local account (stored only in this browser on this device).
3. Log in to enter dashboard.
4. On next app load, active session is restored automatically.
5. Use **Wyloguj** to end the session.

## ZIP import flow

1. In dashboard, choose one or more files in **Pliki historii Spotify (.json lub .zip)**.
2. ZIP files are unpacked client-side and all JSON files inside are parsed.
3. Parsed rows are merged and normalized the same way as direct JSON import.
4. Status shows loaded records, skipped rows, and parsing/file errors.

## Persistent storage and reset

- Each local account has its own saved history, genre map, source metadata, and range setting.
- After login, saved local data is automatically loaded (manual reimport is optional).
- Use **Wyczyść lokalne dane** to remove saved analytics data for the current user.

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

In your Spotify app dashboard, configure redirect URI (for local Streamlit typically `http://localhost:8501`), then set these values once for the deployment (users only click **Connect Spotify account**; they do not need individual secrets):

```toml
# .streamlit/secrets.toml
SPOTIFY_CLIENT_ID = "your_client_id"
SPOTIFY_REDIRECT_URI = "http://localhost:8501"
```

You can also provide the same values as environment variables (`SPOTIFY_CLIENT_ID`, `SPOTIFY_REDIRECT_URI`).

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
