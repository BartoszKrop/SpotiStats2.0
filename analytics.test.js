import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStats, filterByRange, normalizeHistoryRows, parseGenreMap } from './analytics.js';

const sampleRows = [
  {
    endTime: '2026-04-19T10:00:00Z',
    artistName: 'Artist A',
    trackName: 'Track 1',
    albumName: 'Album 1',
    msPlayed: 180000
  },
  {
    endTime: '2026-04-18T23:00:00Z',
    artistName: 'Artist B',
    trackName: 'Track 2',
    albumName: 'Album 2',
    msPlayed: 240000
  },
  {
    endTime: '2025-10-10T11:00:00Z',
    artistName: 'Artist A',
    trackName: 'Track 1',
    albumName: 'Album 1',
    msPlayed: 120000
  }
];

test('normalizeHistoryRows handles standard spotify export schema', () => {
  const normalized = normalizeHistoryRows(sampleRows);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[0].artist, 'Artist A');
  assert.equal(normalized[1].track, 'Track 2');
});

test('filterByRange supports today, week and rolling periods', () => {
  const normalized = normalizeHistoryRows(sampleRows);
  const now = new Date('2026-04-19T12:00:00Z');
  assert.equal(filterByRange(normalized, 'today', now).length, 1);
  assert.equal(filterByRange(normalized, '1w', now).length, 2);
  assert.equal(filterByRange(normalized, '6m', now).length, 2);
  assert.equal(filterByRange(normalized, '1m', now).length, 2);
  assert.equal(filterByRange(normalized, 'all', now).length, 3);
});

test('buildStats returns top entities and activity metrics', () => {
  const normalized = normalizeHistoryRows(sampleRows);
  const genreMap = parseGenreMap({ 'Artist A': ['pop'], 'Artist B': ['rock'] });
  const stats = buildStats(normalized, genreMap);

  assert.equal(stats.summary.totalPlays, 3);
  assert.equal(stats.topArtists[0].label, 'Artist A');
  assert.equal(stats.topTracks[0].label, 'Track 1 — Artist A');
  assert.equal(stats.topAlbums[0].label, 'Album 1 — Artist A');
  assert.deepEqual(
    stats.topGenres.map((genre) => genre.label).sort(),
    ['pop', 'rock']
  );
  assert.equal(stats.weekdayHours.length, 7);
  assert.equal(stats.hourlyHours.length, 24);
});
