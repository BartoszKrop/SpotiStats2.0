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

Open `/home/runner/work/SpotiStats2.0/SpotiStats2.0/index.html` in a browser.

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
node --test /home/runner/work/SpotiStats2.0/SpotiStats2.0/analytics.test.js
```
