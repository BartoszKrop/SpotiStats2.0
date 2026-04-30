# SpotiStats 2.0

SpotiStats 2.0 is a privacy-first, browser-based Spotify listening history dashboard.
All data stays on your device — no server, no account required beyond a local profile.

## Features

- **Local accounts** — create a profile with a username and password; data is stored only in your browser
- **Session persistence** — optional "Stay signed in" keeps you logged in across browser restarts
- **ZIP import** — upload the `.zip` file Spotify emails you directly; all JSON files inside are extracted automatically
- **JSON import** — also accepts individual Spotify history JSON files (drag-and-drop or file picker)
- **Persistent data** — imported history is saved to IndexedDB so you don't re-upload every visit
- **Reimport / Clear** — update your data or wipe it entirely from the dashboard toolbar
- **Time ranges** — All time · 12 months · This year · 6 months · 3 months · 1 month · 1 week · Today
- **Top lists** — artists, tracks, albums, genres (with listening hours + play counts)
- **Activity patterns** — bar charts by weekday and hour of day
- **Demo mode** — load sample data without uploading any files

## How to run

Open `index.html` in any modern browser (Chrome, Edge, Safari, Firefox).
No build step, no server, no dependencies to install.

> **Note:** The SHA-256 password hashing requires the Web Crypto API.
> Chrome, Edge, and Safari support this on `file://` URLs.
> Firefox users may need to serve the app via a local server:
> ```bash
> python -m http.server 8080
> # then open http://localhost:8080
> ```

## Importing your Spotify data

1. In Spotify, go to **Settings → Privacy → Download your data**.
2. Request an account data export (Spotify emails you a link within a few days).
3. Download the `.zip` file from the email link.
4. In SpotiStats, sign in and click **Drop file or click to browse** — select the `.zip` directly.
   SpotiStats reads every JSON file inside the archive automatically (including multi-year exports).

You can also drag-and-drop the `.zip` onto the upload zone.

## Local auth details

- Usernames and hashed passwords are stored in `localStorage` under the key `ss_users`.
- Passwords are hashed with SHA-256 (salted with the username) before storage.
- Listening history is stored in IndexedDB (`SpotiStats` database, `userData` store).
- Nothing is transmitted outside your browser.

## Data format

SpotiStats accepts the Spotify Extended Streaming History JSON schema
(`ts`, `master_metadata_album_artist_name`, `master_metadata_track_name`, etc.)
as well as the older short-history format (`endTime`, `artistName`, `trackName`, `msPlayed`).

## Genre map (optional)

You can enrich genre data by uploading a JSON map alongside your history files:

```json
{ "Artist Name": ["genre1", "genre2"] }
```

or the array format:

```json
[{ "artist": "Artist Name", "genres": ["genre1", "genre2"] }]
```

## Tests

Run the analytics unit tests (Node.js 18+):

```bash
node --test analytics.test.js
```

## Architecture notes

| Layer        | Technology                                             |
|--------------|--------------------------------------------------------|
| UI / App     | Vanilla HTML + CSS + ES modules (no framework)         |
| Analytics    | `analytics.js` — pure functions, fully unit-tested     |
| Auth store   | `localStorage`                                         |
| Data store   | IndexedDB (handles large history exports)              |
| ZIP parsing  | `jszip.min.js` (bundled locally, no CDN required)      |

For production / multi-user scenarios see suggested architectures in `/docs/statsfm-feature-parity.md`.

