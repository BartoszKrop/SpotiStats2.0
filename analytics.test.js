// Uruchom: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./analytics.js');

function ext(ts, artist, track, ms, extra = {}) {
  return {
    ts,
    ms_played: ms,
    master_metadata_track_name: track,
    master_metadata_album_artist_name: artist,
    master_metadata_album_album_name: `${artist} LP`,
    spotify_track_uri: track ? `spotify:track:${artist}-${track}` : null,
    episode_name: null,
    spotify_episode_uri: null,
    skipped: false,
    ...extra
  };
}

test('classifyFile rozpoznaje pliki z historią', () => {
  assert.equal(A.classifyFile('Spotify Extended Streaming History/Streaming_History_Audio_2023_1.json'), 'extended');
  assert.equal(A.classifyFile('MyData/endsong_0.json'), 'extended');
  assert.equal(A.classifyFile('Spotify Account Data/StreamingHistory_music_0.json'), 'short');
  assert.equal(A.classifyFile('Spotify Account Data/StreamingHistory0.json'), 'short');
  assert.equal(A.classifyFile('Spotify Account Data/StreamingHistory_podcast_0.json'), 'skip');
  assert.equal(A.classifyFile('Spotify Account Data/Userdata.json'), 'skip');
  assert.equal(A.classifyFile('Spotify Account Data/SearchQueries.json'), 'skip');
  assert.equal(A.classifyFile('ReadMeFirst.pdf'), 'skip');
});

test('normalizeRows odrzuca podcasty, puste wiersze i duplikaty', () => {
  const rows = [
    ext('2026-01-01T10:00:00Z', 'A', 'Song', 200000),
    ext('2026-01-01T10:00:00Z', 'A', 'Song', 200000), // duplikat z nakładających się plików
    ext('2026-01-01T11:00:00Z', null, null, 1500000, { episode_name: 'Odc. 1', spotify_episode_uri: 'spotify:episode:x' }),
    ext('2026-01-01T12:00:00Z', null, null, 50000), // brak metadanych
    ext('2026-01-01T13:00:00Z', 'B', 'Other', 0), // 0 ms
    { endTime: '2025-12-31 23:59', artistName: 'C', trackName: 'Krótki', msPlayed: 90000 }
  ];
  const { rows: out, report } = A.normalizeRows(rows);
  assert.equal(out.length, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.podcasts, 2);
  assert.equal(report.invalid, 1);
  assert.equal(out[0].artist, 'C'); // posortowane rosnąco
  assert.equal(out[0].t, Date.parse('2025-12-31T23:59:00Z'));
});

test('combineFiles pomija krótką historię, gdy jest rozszerzona', () => {
  const files = [
    { name: 'Spotify Extended Streaming History/Streaming_History_Audio_2026.json', data: [ext('2026-01-01T10:00:00Z', 'A', 'S', 100000)] },
    { name: 'Spotify Account Data/StreamingHistory_music_0.json', data: [{ endTime: '2026-01-01 10:00', artistName: 'A', trackName: 'S', msPlayed: 100000 }] },
    { name: 'Spotify Account Data/Userdata.json', data: { username: 'x' } }
  ];
  const { rows, report } = A.combineFiles(files);
  assert.equal(rows.length, 1);
  assert.equal(report.format, 'extended');
  assert.equal(report.skippedFiles.length, 2);
});

test('top liczy odtworzenia tylko od 30 s, czas zawsze', () => {
  const { rows } = A.normalizeRows([
    ext('2026-01-01T10:00:00Z', 'A', 'S1', 200000),
    ext('2026-01-01T10:05:00Z', 'A', 'S1', 5000), // przewinięte
    ext('2026-01-01T10:10:00Z', 'B', 'S2', 60000),
    ext('2026-01-01T10:20:00Z', 'B', 'S2', 60000),
    ext('2026-01-01T10:30:00Z', 'B', 'S3', 60000)
  ]);
  const byTime = A.top(rows, 'artist');
  assert.deepEqual(byTime.map((a) => [a.name, a.plays, a.ms]), [['A', 1, 205000], ['B', 3, 180000]]);
  const byPlays = A.top(rows, 'artist', { sortBy: 'plays' });
  assert.equal(byPlays[0].name, 'B');
  const tracks = A.top(rows, 'track');
  assert.equal(tracks[0].name, 'S1');
  assert.equal(tracks[0].artist, 'A');
});

test('rangeBounds: 7 dni, 28 dni, pół roku, rok, all time', () => {
  const anchor = new Date(2026, 10, 20, 15, 0).getTime(); // 20 lis 2026, 15:00
  const end = new Date(2026, 10, 21).getTime();
  assert.deepEqual(A.rangeBounds('7d', anchor), { from: new Date(2026, 10, 14).getTime(), to: end });
  assert.deepEqual(A.rangeBounds('28d', anchor), { from: new Date(2026, 9, 24).getTime(), to: end });
  assert.deepEqual(A.rangeBounds('6m', anchor), { from: new Date(2026, 4, 21).getTime(), to: end });
  assert.deepEqual(A.rangeBounds('year', anchor, { year: 2024 }), { from: new Date(2024, 0, 1).getTime(), to: new Date(2025, 0, 1).getTime() });
  assert.deepEqual(A.rangeBounds('all', anchor, { first: 5 }), { from: 5, to: end });
});

test('sliceRange wycina po czasie (wyszukiwanie binarne)', () => {
  const rows = [1, 5, 10, 20].map((t) => ({ t }));
  assert.deepEqual(A.sliceRange(rows, 5, 20).map((r) => r.t), [5, 10]);
  assert.deepEqual(A.sliceRange(rows, 0, 100).length, 4);
});

test('timeline sumuje minuty w tygodniach od poniedziałku i wypełnia zera', () => {
  const t = (d, h = 12) => new Date(2026, 0, d, h).getTime(); // styczeń 2026, 5 sty = poniedziałek
  const rows = [
    { t: t(5), artist: 'A', ms: 120000 },
    { t: t(11), artist: 'A', ms: 60000 }, // niedziela, ten sam tydzień
    { t: t(12), artist: 'B', ms: 60000 },
    { t: t(26), artist: 'A', ms: 30000 }
  ];
  const tl = A.timeline(rows, t(5, 0), t(27, 0), 'week', [
    { key: 'A', match: (r) => r.artist === 'A' },
    { key: 'B', match: (r) => r.artist === 'B' }
  ]);
  assert.equal(tl.buckets.length, 4);
  assert.equal(tl.buckets[0], new Date(2026, 0, 5).getTime());
  assert.deepEqual(tl.series[0].values, [3, 0, 0, 0.5]);
  assert.deepEqual(tl.series[1].values, [0, 1, 0, 0]);
});

test('timeline miesięczny i dzienny', () => {
  const rows = [{ t: new Date(2026, 1, 3).getTime(), artist: 'A', ms: 60000 }];
  const m = A.timeline(rows, new Date(2026, 0, 15).getTime(), new Date(2026, 3, 1).getTime(), 'month', [{ key: 'A', match: () => true }]);
  assert.deepEqual(m.series[0].values, [0, 1, 0]);
  const d = A.timeline(rows, new Date(2026, 1, 1).getTime(), new Date(2026, 1, 8).getTime(), 'day', [{ key: 'A', match: () => true }]);
  assert.equal(d.buckets.length, 7);
  assert.deepEqual(d.series[0].values, [0, 0, 1, 0, 0, 0, 0]);
});

test('artistDetails', () => {
  const { rows } = A.normalizeRows([
    ext('2025-01-01T10:00:00Z', 'A', 'S1', 200000),
    ext('2026-01-01T10:00:00Z', 'A', 'S2', 100000),
    ext('2026-01-02T10:00:00Z', 'B', 'S3', 100000)
  ]);
  const d = A.artistDetails(rows, 'A');
  assert.equal(d.plays, 2);
  assert.equal(d.tracks, 2);
  assert.equal(d.first, Date.parse('2025-01-01T10:00:00Z'));
  assert.equal(d.topTracks[0].name, 'S1');
});

test('ten sam utwór pod dwoma URI (singiel + album) liczy się razem', () => {
  const { rows } = A.normalizeRows([
    ext('2026-01-01T10:00:00Z', 'A', 'Song', 100000, { spotify_track_uri: 'spotify:track:single' }),
    ext('2026-01-02T10:00:00Z', 'A', 'Song', 100000, { spotify_track_uri: 'spotify:track:album' })
  ]);
  const tracks = A.top(rows, 'track');
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].plays, 2);
});

test('rankTimeline: kto był nr 1 w każdym tygodniu', () => {
  const t = (d) => new Date(2026, 0, d, 12).getTime(); // 5 sty 2026 = poniedziałek
  const rows = [
    { t: t(5), artist: 'A', ms: 300000 }, { t: t(6), artist: 'B', ms: 100000 },
    { t: t(12), artist: 'B', ms: 400000 }, { t: t(13), artist: 'A', ms: 100000 }, { t: t(14), artist: 'C', ms: 50000 },
    { t: t(19), artist: 'B', ms: 200000 }
  ];
  const r = A.rankTimeline(rows, new Date(2026, 0, 5).getTime(), new Date(2026, 0, 26).getTime(), 'week', { depth: 2, limit: 3 });
  assert.deepEqual(r.leaders.map((l) => l && l.name), ['A', 'B', 'B']);
  assert.deepEqual(r.kings, [{ name: 'B', weeks: 2 }, { name: 'A', weeks: 1 }]);
  const byKey = Object.fromEntries(r.series.map((s) => [s.key, s.values]));
  assert.deepEqual(byKey.B, [2, 1, 1]);
  assert.deepEqual(byKey.A, [1, 2, null]);
  assert.deepEqual(byKey.C, [null, null, null]); // C był 3. — poza depth=2
  const out = A.rankTimeline(rows, new Date(2026, 0, 5).getTime(), new Date(2026, 1, 2).getTime(), 'week', { depth: 2, limit: 3, outside: true });
  const o = Object.fromEntries(out.series.map((s) => [s.key, s.values]));
  assert.deepEqual(o.A, [1, 2, 3, null]); // 3 = „poza top 2”, null = tydzień bez odsłuchów
});

test('listeningHours: godziny i dni tygodnia w czasie lokalnym', () => {
  const t = (d, h) => new Date(2026, 0, d, h, 30).getTime(); // 5 sty 2026 = poniedziałek
  const r = A.listeningHours([
    { t: t(5, 8), ms: 60000 }, { t: t(5, 8), ms: 60000 }, { t: t(11, 23), ms: 30000 } // niedziela 23:30
  ]);
  assert.equal(r.hours[8], 120000);
  assert.equal(r.hours[23], 30000);
  assert.equal(r.days[0], 120000);
  assert.equal(r.days[6], 30000);
  assert.equal(r.peakHour, 8);
  assert.equal(r.peakDay, 0);
  assert.equal(A.listeningHours([]).peakHour, null);
});

test('records: najdłuższa seria na nr 1, łączna liczba tygodni i największy peak', () => {
  const t = (d) => new Date(2026, 0, d, 12).getTime(); // 5 sty 2026 = poniedziałek
  const rows = [
    { t: t(5), artist: 'A', track: 'a1', ms: 300000 }, { t: t(6), artist: 'B', track: 'b1', ms: 100000 },   // tydz. 1: A
    { t: t(12), artist: 'A', track: 'a1', ms: 200000 }, { t: t(13), artist: 'B', track: 'b1', ms: 100000 }, // tydz. 2: A
    { t: t(19), artist: 'B', track: 'b1', ms: 500000 },                                                    // tydz. 3: B
    { t: t(26), artist: 'A', track: 'a2', ms: 900000 },                                                    // tydz. 4: A
    { t: t(2 + 35), artist: 'A', track: 'a2', ms: 100000 }                                                 // tydz. 6 (po przerwie): A
  ];
  const r = A.records(rows, 'artist');
  assert.equal(r.longest.name, 'A');
  assert.equal(r.longest.weeks, 2);
  assert.equal(r.leaders[0].name, 'A');
  assert.equal(r.leaders[0].weeks, 4);
  assert.equal(r.leaders[0].longest, 2);
  assert.equal(r.leaders.find((x) => x.name === 'B').weeks, 1);
  assert.equal(r.peaks[0].name, 'A');
  assert.equal(r.peaks[0].ms, 900000);
  const tr = A.records(rows, 'track');
  assert.equal(tr.peaks[0].name, 'a2');
  assert.equal(tr.peaks[0].week, new Date(2026, 0, 26).getTime());
});
