const TOP_LIMIT = 10;

const RANGE_BUILDERS = {
  all: () => null,
  '12m': (now) => new Date(now.getFullYear(), now.getMonth() - 12, now.getDate()),
  year: (now) => new Date(now.getFullYear(), 0, 1),
  '6m': (now) => new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()),
  '3m': (now) => new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()),
  '1m': (now) => new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()),
  '1w': (now) => new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
  today: (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate())
};

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function entryDate(entry) {
  return new Date(entry.timestamp);
}

function durationToHours(ms) {
  return (ms / 3_600_000).toFixed(2);
}

function durationToMinutes(ms) {
  return (ms / 60_000).toFixed(1);
}

function topFromCounter(counter, formatter = (key) => key) {
  return [...counter.entries()]
    .sort((a, b) => b[1].ms - a[1].ms || b[1].plays - a[1].plays || a[0].localeCompare(b[0]))
    .slice(0, TOP_LIMIT)
    .map(([key, value]) => ({
      label: formatter(key),
      plays: value.plays,
      hours: Number(durationToHours(value.ms))
    }));
}

function updateCounter(counter, key, ms) {
  if (!key) return;
  if (!counter.has(key)) counter.set(key, { plays: 0, ms: 0 });
  const entry = counter.get(key);
  entry.plays += 1;
  entry.ms += ms;
}

export function normalizeHistoryRows(rawRows) {
  return rawRows
    .map((row) => {
      const timestamp = row.ts || row.endTime || row.end_time;
      const artist =
        row.master_metadata_album_artist_name || row.artistName || row.artist || 'Unknown artist';
      const track = row.master_metadata_track_name || row.trackName || row.track || 'Unknown track';
      const album =
        row.master_metadata_album_album_name || row.albumName || row.album || 'Unknown album';
      const msPlayed = Number(row.ms_played ?? row.msPlayed ?? 0);
      if (!timestamp || Number.isNaN(msPlayed) || msPlayed <= 0) return null;
      const parsed = new Date(timestamp);
      if (Number.isNaN(parsed.getTime())) return null;
      return {
        timestamp: parsed.toISOString(),
        artist,
        track,
        album,
        msPlayed
      };
    })
    .filter(Boolean);
}

export function parseGenreMap(rawGenreData) {
  if (!rawGenreData) return new Map();

  if (Array.isArray(rawGenreData)) {
    return new Map(
      rawGenreData
        .filter((item) => item && item.artist && Array.isArray(item.genres))
        .map((item) => [item.artist, item.genres])
    );
  }

  if (typeof rawGenreData === 'object') {
    return new Map(
      Object.entries(rawGenreData).filter(([, value]) => Array.isArray(value))
    );
  }

  return new Map();
}

export function filterByRange(entries, range, now = new Date()) {
  const resolver = RANGE_BUILDERS[range] || RANGE_BUILDERS.all;
  const lowerBound = resolver(now);
  if (!lowerBound) return entries;
  return entries.filter((entry) => entryDate(entry) >= lowerBound && entryDate(entry) <= now);
}

export function buildStats(entries, genreMap) {
  const artistCounter = new Map();
  const trackCounter = new Map();
  const albumCounter = new Map();
  const genreCounter = new Map();
  const byDay = new Map();
  const byWeekday = new Map(WEEKDAY.map((day) => [day, 0]));
  const byHour = new Map(Array.from({ length: 24 }, (_, hour) => [hour, 0]));

  let totalMs = 0;

  for (const entry of entries) {
    totalMs += entry.msPlayed;
    updateCounter(artistCounter, entry.artist, entry.msPlayed);
    updateCounter(trackCounter, `${entry.track} — ${entry.artist}`, entry.msPlayed);
    updateCounter(albumCounter, `${entry.album} — ${entry.artist}`, entry.msPlayed);

    const genres = genreMap.get(entry.artist) || ['Unknown'];
    for (const genre of genres) {
      updateCounter(genreCounter, genre, entry.msPlayed);
    }

    const date = entryDate(entry);
    const dayKey = date.toISOString().slice(0, 10);
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + entry.msPlayed);

    const weekday = WEEKDAY[date.getDay()];
    byWeekday.set(weekday, (byWeekday.get(weekday) || 0) + entry.msPlayed);

    const hour = date.getHours();
    byHour.set(hour, (byHour.get(hour) || 0) + entry.msPlayed);
  }

  const activeDays = Math.max(byDay.size, 1);

  return {
    summary: {
      totalPlays: entries.length,
      totalHours: Number(durationToHours(totalMs)),
      avgDailyMinutes: Number(durationToMinutes(totalMs / activeDays))
    },
    topArtists: topFromCounter(artistCounter),
    topTracks: topFromCounter(trackCounter),
    topAlbums: topFromCounter(albumCounter),
    topGenres: topFromCounter(genreCounter),
    weekdayHours: [...byWeekday.entries()].map(([day, ms]) => ({ day, hours: Number(durationToHours(ms)) })),
    hourlyHours: [...byHour.entries()].map(([hour, ms]) => ({ hour, hours: Number(durationToHours(ms)) }))
  };
}
