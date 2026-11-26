/*
 * SpotiStats — analityka (czyste funkcje, bez DOM).
 *
 * Zwykły skrypt (nie moduł ES), żeby strona działała też po dwukliku
 * w index.html (file://). W przeglądarce wystawia `window.SpotiAnalytics`,
 * w Node eksportuje to samo przez `module.exports` (testy).
 *
 * Wiersz po normalizacji: { t: epoch ms, artist, track, album, uri, ms }
 */
(function (root) {
  'use strict';

  const DAY_MS = 86_400_000;
  /** Odsłuch krótszy niż 30 s nie liczy się jako „odtworzenie” (jak w stats.fm), ale minuty tak. */
  const MIN_STREAM_MS = 30_000;

  // ────────────────────────────────────────────────────────── IMPORT

  /** Czy plik z paczki Spotify zawiera historię słuchania (a nie np. Userdata.json). */
  function classifyFile(name) {
    const base = String(name).split('/').pop().toLowerCase();
    if (!base.endsWith('.json')) return 'skip';
    if (base.includes('podcast')) return 'skip';
    if (/^streaming_history_(audio|video)/.test(base) || /^endsong/.test(base)) return 'extended';
    if (/^streaminghistory/.test(base)) return 'short';
    return 'skip';
  }

  function isPodcastRow(row) {
    return Boolean(
      row.episode_name || row.episode_show_name || row.spotify_episode_uri ||
      row.audiobook_title || row.audiobook_uri || row.audiobook_chapter_title ||
      row.podcastName || row.episodeName
    );
  }

  /**
   * Normalizuje surowe wiersze z jednego lub wielu plików.
   * Zwraca posortowane wiersze + raport (ile podcastów, duplikatów itd.).
   */
  function normalizeRows(rawRows) {
    const rows = [];
    const seen = new Set();
    const report = { total: rawRows.length, kept: 0, podcasts: 0, invalid: 0, duplicates: 0 };

    for (const row of rawRows) {
      if (!row || typeof row !== 'object') { report.invalid++; continue; }
      if (isPodcastRow(row)) { report.podcasts++; continue; }

      const ts = row.ts || row.endTime || row.end_time;
      const artist = row.master_metadata_album_artist_name ?? row.artistName ?? row.artist;
      const track = row.master_metadata_track_name ?? row.trackName ?? row.track;
      const album = row.master_metadata_album_album_name ?? row.albumName ?? row.album ?? '';
      const ms = Number(row.ms_played ?? row.msPlayed ?? 0);

      // Brak wykonawcy/utworu = podcast, audiobook albo wpis techniczny — pomijamy.
      if (!artist || !track) { report.podcasts++; continue; }
      if (!ts || !Number.isFinite(ms) || ms <= 0) { report.invalid++; continue; }

      // Krótki format ma "2024-01-31 18:05" (UTC wg dokumentacji Spotify).
      const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(ts) ? ts.replace(' ', 'T') + 'Z' : ts;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) { report.invalid++; continue; }

      const uri = row.spotify_track_uri || '';
      const key = `${t}|${uri || artist + '|' + track}|${ms}`;
      if (seen.has(key)) { report.duplicates++; continue; }
      seen.add(key);

      rows.push({ t, artist, track, album, uri, ms });
    }

    rows.sort((a, b) => a.t - b.t);
    report.kept = rows.length;
    return { rows, report };
  }

  /**
   * Łączy pliki z paczki. `files` = [{ name, data }], gdzie data to już sparsowany JSON.
   * Jeśli jest rozszerzona historia (Extended Streaming History), krótka
   * (StreamingHistory_music_*.json z „Account data”) jest pomijana — to podzbiór
   * tych samych odsłuchów z minutową dokładnością, więc by się zdublował.
   */
  function combineFiles(files) {
    const extended = [];
    const short = [];
    const skippedFiles = [];
    for (const f of files) {
      const kind = classifyFile(f.name);
      if (kind === 'skip' || !Array.isArray(f.data)) { skippedFiles.push(f.name); continue; }
      (kind === 'extended' ? extended : short).push(f);
    }
    const used = extended.length ? extended : short;
    if (extended.length) for (const f of short) skippedFiles.push(f.name);
    const raw = [];
    for (const f of used) for (const r of f.data) raw.push(r);
    const result = normalizeRows(raw);
    result.report.usedFiles = used.map((f) => f.name);
    result.report.skippedFiles = skippedFiles;
    result.report.format = extended.length ? 'extended' : short.length ? 'short' : 'none';
    return result;
  }

  // ────────────────────────────────────────────────────────── ZAKRESY

  function startOfDay(ms) {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /**
   * Zakres dat. `anchor` = moment, od którego liczymy wstecz (domyślnie ostatni
   * odsłuch w danych — eksport Spotify bywa sprzed kilku tygodni, a liczenie
   * od „dziś” dawałoby puste 7 dni).
   * id: '7d' | '28d' | '6m' | 'year' (z parametrem year) | 'all'
   * Zwraca { from, to } (to = wyłącznie, epoch ms).
   */
  function rangeBounds(id, anchor, opts = {}) {
    const end = startOfDay(anchor) + DAY_MS; // koniec dnia kotwicy
    switch (id) {
      case '7d': return { from: end - 7 * DAY_MS, to: end };
      case '28d': return { from: end - 28 * DAY_MS, to: end };
      case '6m': {
        const d = new Date(end);
        return { from: new Date(d.getFullYear(), d.getMonth() - 6, d.getDate()).getTime(), to: end };
      }
      case 'year': {
        const y = opts.year ?? new Date(anchor).getFullYear();
        return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
      }
      default:
        return { from: opts.first ?? 0, to: end };
    }
  }

  /** Wiersze muszą być posortowane po t. Wyszukiwanie binarne. */
  function lowerIndex(rows, t) {
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function sliceRange(rows, from, to) {
    return rows.slice(lowerIndex(rows, from), lowerIndex(rows, to));
  }

  function yearsIn(rows) {
    if (!rows.length) return [];
    const a = new Date(rows[0].t).getFullYear();
    const b = new Date(rows[rows.length - 1].t).getFullYear();
    const out = [];
    for (let y = b; y >= a; y--) out.push(y);
    return out;
  }

  // ────────────────────────────────────────────────────────── TOPKI

  /** Ten sam utwór bywa pod kilkoma URI (singiel i album) — łączymy po nazwie i wykonawcy. */
  const trackKey = (r) => `${r.track.toLowerCase()}\u0000${r.artist}`;

  const KEYERS = {
    artist: (r) => r.artist,
    track: trackKey,
    album: (r) => `${r.album}\u0000${r.artist}`
  };

  function aggregate(rows, kind) {
    const keyOf = KEYERS[kind];
    const map = new Map();
    for (const r of rows) {
      const key = keyOf(r);
      let e = map.get(key);
      if (!e) {
        e = { key, name: kind === 'artist' ? r.artist : kind === 'track' ? r.track : r.album, artist: r.artist, ms: 0, plays: 0 };
        map.set(key, e);
      }
      e.ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) e.plays++;
    }
    return map;
  }

  /** Top N wykonawców/utworów/albumów. sortBy: 'ms' (czas) | 'plays' (odtworzenia). */
  function top(rows, kind, { sortBy = 'ms', limit = 10 } = {}) {
    const list = [...aggregate(rows, kind).values()];
    const primary = sortBy === 'plays' ? 'plays' : 'ms';
    const secondary = primary === 'ms' ? 'plays' : 'ms';
    list.sort((a, b) => b[primary] - a[primary] || b[secondary] - a[secondary] || a.name.localeCompare(b.name));
    return limit ? list.slice(0, limit) : list;
  }

  function summary(rows, from, to) {
    let ms = 0, plays = 0;
    const artists = new Set(), tracks = new Set();
    for (const r of rows) {
      ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) plays++;
      artists.add(r.artist);
      tracks.add(trackKey(r));
    }
    const days = Math.max(1, Math.round((to - from) / DAY_MS));
    return { ms, plays, artists: artists.size, tracks: tracks.size, minutesPerDay: ms / 60_000 / days };
  }

  // ────────────────────────────────────────────────────────── OSIE CZASU

  /** Początek kubełka: dzień, tydzień (od poniedziałku) albo miesiąc — w czasie lokalnym. */
  function bucketStart(ms, unit) {
    const d = new Date(ms);
    if (unit === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    if (unit === 'week') {
      const dow = (d.getDay() + 6) % 7; // pon = 0
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
    }
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function nextBucket(ms, unit) {
    const d = new Date(ms);
    if (unit === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    if (unit === 'week') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  }

  function bucketList(from, to, unit) {
    const out = [];
    for (let b = bucketStart(from, unit); b < to; b = nextBucket(b, unit)) out.push(b);
    return out;
  }

  /** Sensowna domyślna agregacja dla długości zakresu. */
  function defaultUnit(from, to) {
    const days = (to - from) / DAY_MS;
    if (days <= 62) return 'day';
    if (days <= 8 * 366) return 'week';
    return 'month';
  }

  /**
   * Minuty słuchania w kubełkach dla wskazanych serii.
   * series: [{ key, match: (row) => boolean }]
   * Zwraca { buckets: [epoch ms], series: [{ key, values: [minuty] }] }
   */
  function timeline(rows, from, to, unit, series) {
    const buckets = bucketList(from, to, unit);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const values = series.map(() => new Array(buckets.length).fill(0));
    for (const r of rows) {
      if (r.t < from || r.t >= to) continue;
      const i = index.get(bucketStart(r.t, unit));
      if (i === undefined) continue;
      for (let s = 0; s < series.length; s++) {
        if (series[s].match(r)) values[s][i] += r.ms / 60_000;
      }
    }
    return {
      buckets,
      series: series.map((s, i) => ({ key: s.key, values: values[i].map((v) => Math.round(v * 10) / 10) }))
    };
  }

  /** Szczegóły wykonawcy: suma, pierwszy/ostatni odsłuch, top utwory. */
  function artistDetails(rows, artist) {
    const own = rows.filter((r) => r.artist === artist);
    const s = summary(own, 0, 1);
    return {
      artist,
      ms: s.ms,
      plays: s.plays,
      tracks: s.tracks,
      first: own.length ? own[0].t : null,
      last: own.length ? own[own.length - 1].t : null,
      topTracks: top(own, 'track', { limit: 10 })
    };
  }

  function allArtists(rows) {
    return top(rows, 'artist', { limit: 0 }).map((a) => a.name);
  }

  const API = {
    MIN_STREAM_MS,
    trackKey,
    classifyFile,
    isPodcastRow,
    normalizeRows,
    combineFiles,
    rangeBounds,
    sliceRange,
    yearsIn,
    top,
    summary,
    bucketStart,
    bucketList,
    defaultUnit,
    timeline,
    artistDetails,
    allArtists
  };

  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.SpotiAnalytics = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
