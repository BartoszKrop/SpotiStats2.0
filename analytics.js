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
        e = { key, name: kind === 'artist' ? r.artist : kind === 'track' ? r.track : r.album, artist: r.artist, album: r.album, ms: 0, plays: 0 };
        map.set(key, e);
      }
      e.ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) e.plays++;
    }
    return map;
  }

  /** Top N wykonawców/utworów/albumów. sortBy: 'ms' (czas) | 'plays' (odtworzenia). */
  // Pamięć podręczna: ta sama tablica wierszy + rodzaj + sortowanie = ten sam wynik (strona pyta wielokrotnie).
  const topCache = new WeakMap();
  function top(rows, kind, { sortBy = 'ms', limit = 10 } = {}) {
    let perRows = topCache.get(rows);
    if (!perRows) { perRows = new Map(); topCache.set(rows, perRows); }
    const ck = `${kind}|${sortBy}`;
    let list = perRows.get(ck);
    if (!list) {
      list = [...aggregate(rows, kind).values()];
      const primary = sortBy === 'plays' ? 'plays' : 'ms';
      const secondary = primary === 'ms' ? 'plays' : 'ms';
      list.sort((a, b) => b[primary] - a[primary] || b[secondary] - a[secondary] || a.name.localeCompare(b.name));
      perRows.set(ck, list);
    }
    return limit ? list.slice(0, limit) : list.slice();
  }

  function summary(rows, from, to) {
    let ms = 0, plays = 0;
    const artists = new Set(), tracks = new Set(), albums = new Set();
    for (const r of rows) {
      ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) plays++;
      artists.add(r.artist);
      tracks.add(trackKey(r));
      if (r.album) albums.add(KEYERS.album(r));
    }
    const days = Math.max(1, Math.round((to - from) / DAY_MS));
    return { ms, plays, artists: artists.size, tracks: tracks.size, albums: albums.size, minutesPerDay: ms / 60_000 / days };
  }

  // ────────────────────────────────────────────────────────── OSIE CZASU

  /** Początek kubełka: dzień, tydzień (od poniedziałku) albo miesiąc — w czasie lokalnym. */
  // Wiersze zwykle idą po kolei w czasie, więc zapamiętanie ostatniego kubełka oszczędza tysiące obiektów Date.
  let lastBucket = { unit: null, lo: 0, hi: -1 };
  function bucketStart(ms, unit) {
    const c = lastBucket;
    if (c.unit === unit && ms >= c.lo && ms < c.hi) return c.lo;
    const lo = bucketStartRaw(ms, unit);
    lastBucket = { unit, lo, hi: nextBucket(lo, unit) };
    return lo;
  }
  function bucketStartRaw(ms, unit) {
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

  /**
   * Ranking wykonawców w każdym kubełku (tydzień/miesiąc).
   * Zwraca:
   *   buckets  — początki kubełków,
   *   leaders  — dla każdego kubełka { name, ms } nr 1 (albo null, gdy nic nie grało),
   *   kings    — [{ name, weeks }] kto ile razy był nr 1 (malejąco),
   *   series   — [{ key, values }] pozycje 1..depth (null = poza topką) dla `limit` wykonawców,
   *              którzy najczęściej byli nr 1 (dobierani dalej wg łącznego czasu).
   */
  /**
   * outside: true → zamiast null (poza top `depth`) zwraca depth + 1, żeby linia schodziła na dół wykresu
   * zamiast się urywać; null zostaje tylko dla okresów bez żadnych odsłuchów.
   */
  function rankTimeline(rows, from, to, unit, { depth = 10, limit = 6, sortBy = 'ms', outside = false } = {}) {
    const buckets = bucketList(from, to, unit);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const per = buckets.map(() => new Map());
    for (const r of rows) {
      if (r.t < from || r.t >= to) continue;
      const i = index.get(bucketStart(r.t, unit));
      if (i === undefined) continue;
      let e = per[i].get(r.artist);
      if (!e) per[i].set(r.artist, (e = { ms: 0, plays: 0 }));
      e.ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) e.plays++;
    }
    const metric = sortBy === 'plays' ? 'plays' : 'ms';
    const other = metric === 'ms' ? 'plays' : 'ms';
    const rankings = per.map((m) =>
      [...m.entries()].sort((a, b) => b[1][metric] - a[1][metric] || b[1][other] - a[1][other] || a[0].localeCompare(b[0])));
    const leaders = rankings.map((list) => (list.length ? { name: list[0][0], ms: list[0][1].ms, plays: list[0][1].plays } : null));

    const kingCount = new Map();
    for (const l of leaders) if (l) kingCount.set(l.name, (kingCount.get(l.name) || 0) + 1);
    const kings = [...kingCount.entries()].map(([name, weeks]) => ({ name, weeks })).sort((a, b) => b.weeks - a.weeks || a.name.localeCompare(b.name));

    const chosen = kings.slice(0, limit).map((k) => k.name);
    if (chosen.length < limit) {
      for (const a of top(rows.filter((r) => r.t >= from && r.t < to), 'artist', { sortBy, limit: limit * 2 })) {
        if (chosen.length >= limit) break;
        if (!chosen.includes(a.name)) chosen.push(a.name);
      }
    }
    const series = chosen.map((name) => ({
      key: name,
      values: rankings.map((list) => {
        const pos = list.findIndex(([n]) => n === name);
        if (pos >= 0 && pos < depth) return pos + 1;
        return outside && list.length ? depth + 1 : null;
      })
    }));
    return { buckets, leaders, kings, series };
  }

  /**
   * Kiedy słuchasz: minuty w każdej godzinie doby (0–23) i w każdym dniu tygodnia (pon = 0), czas lokalny.
   * Zwraca też najlepszą godzinę i najlepszy dzień (null, gdy brak odsłuchów).
   */
  function listeningHours(rows) {
    const hours = new Array(24).fill(0);
    const days = new Array(7).fill(0);
    let total = 0;
    for (const r of rows) {
      const d = new Date(r.t);
      hours[d.getHours()] += r.ms;
      days[(d.getDay() + 6) % 7] += r.ms;
      total += r.ms;
    }
    const argmax = (a) => (total ? a.indexOf(Math.max(...a)) : null);
    return { hours, days, total, peakHour: argmax(hours), peakDay: argmax(days) };
  }

  /**
   * Rekordy z całej historii, tygodniami (poniedziałek–niedziela):
   *  - leaders: kto ile tygodni był nr 1 (łącznie) i jaka była jego najdłuższa seria z rzędu,
   *  - longest: najdłuższa seria tygodni z rzędu na szczycie,
   *  - peaks: tygodnie z największym słuchaniem jednej pozycji (minuty).
   * kind: 'artist' | 'track'. Tydzień bez żadnych odsłuchów przerywa serię.
   */
  /**
   * Pozycja wybranych wykonawców/utworów w rankingu każdego okresu (1 = nr 1).
   * Poza top `depth` → depth+1 („dalej”); okres bez odsłuchów → null.
   * Zwraca też lidera każdego okresu (do dymka).
   */
  function rankSeries(rows, from, to, unit, kind, keys, { depth = 10, sortBy = 'ms' } = {}) {
    const keyOf = KEYERS[kind];
    const buckets = bucketList(from, to, unit);
    const index = new Map(buckets.map((b, i) => [b, i]));
    const per = buckets.map(() => new Map());
    for (const r of rows) {
      if (r.t < from || r.t >= to) continue;
      const i = index.get(bucketStart(r.t, unit));
      if (i === undefined) continue;
      const k = keyOf(r);
      let e = per[i].get(k);
      if (!e) per[i].set(k, (e = { name: kind === 'artist' ? r.artist : kind === 'track' ? r.track : r.album, artist: r.artist, ms: 0, plays: 0 }));
      e.ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) e.plays++;
    }
    const metric = sortBy === 'plays' ? 'plays' : 'ms';
    const other = metric === 'ms' ? 'plays' : 'ms';
    const rankings = per.map((m) => [...m.entries()].sort((a, b) => b[1][metric] - a[1][metric] || b[1][other] - a[1][other] || a[0].localeCompare(b[0])));
    const leaders = rankings.map((list) => (list.length ? { ...list[0][1], key: list[0][0] } : null));
    const series = keys.map((key) => ({
      key,
      values: rankings.map((list) => {
        if (!list.length) return null;
        const pos = list.findIndex(([k]) => k === key);
        return pos >= 0 && pos < depth ? pos + 1 : depth + 1;
      })
    }));
    return { buckets, leaders, series };
  }

  function records(rows, kind, { limit = 5, sortBy = 'ms' } = {}) {
    const keyOf = kind === 'artist' ? (r) => r.artist : (r) => trackKey(r);
    const nameOf = kind === 'artist' ? (r) => r.artist : (r) => r.track;
    const weeks = new Map(); // początek tygodnia -> Map(key -> {name, artist, ms, plays})
    for (const r of rows) {
      const w = bucketStart(r.t, 'week');
      let m = weeks.get(w);
      if (!m) weeks.set(w, (m = new Map()));
      const k = keyOf(r);
      let e = m.get(k);
      if (!e) m.set(k, (e = { name: nameOf(r), artist: r.artist, ms: 0, plays: 0 }));
      e.ms += r.ms;
      if (r.ms >= MIN_STREAM_MS) e.plays++;
    }
    const metric = sortBy === 'plays' ? 'plays' : 'ms';
    const starts = [...weeks.keys()].sort((a, b) => a - b);
    const stat = new Map(); // key -> { name, artist, weeks, longest, longestFrom, run, runFrom }
    const peaks = [];
    let best = null;
    let prevWeek = null, prevKey = null, prevLeader = null;
    for (const w of starts) {
      let leaderKey = null, leader = null;
      for (const [k, e] of weeks.get(w)) {
        peaks.push({ key: k, name: e.name, artist: e.artist, week: w, ms: e.ms, plays: e.plays });
        if (!leader || e[metric] > leader[metric] || (e[metric] === leader[metric] && e.ms > leader.ms)) { leader = e; leaderKey = k; }
      }
      let st = stat.get(leaderKey);
      if (!st) stat.set(leaderKey, (st = { key: leaderKey, name: leader.name, artist: leader.artist, weeks: 0, longest: 0, longestFrom: w, run: 0, runFrom: w }));
      const continues = prevKey === leaderKey && prevWeek != null && nextBucket(prevWeek, 'week') === w;
      if (continues) st.run++;
      else { st.run = 1; st.runFrom = w; }
      st.weeks++;
      if (st.run > st.longest) { st.longest = st.run; st.longestFrom = st.runFrom; }
      if (!best || st.longest > best.weeks) best = { key: leaderKey, name: st.name, artist: st.artist, weeks: st.longest, from: st.longestFrom };
      prevKey = leaderKey;
      prevWeek = w;
      prevLeader = leader;
    }
    const cur = prevKey != null ? stat.get(prevKey) : null;
    const current = cur ? { key: prevKey, name: cur.name, artist: cur.artist, run: cur.run, week: prevWeek, ms: prevLeader.ms, plays: prevLeader.plays } : null;
    const leaders = [...stat.values()].sort((a, b) => b.weeks - a.weeks || b.longest - a.longest || a.name.localeCompare(b.name)).slice(0, limit)
      .map((x) => ({ key: x.key, name: x.name, artist: x.artist, weeks: x.weeks, longest: x.longest, longestFrom: x.longestFrom }));
    peaks.sort((a, b) => b[metric] - a[metric] || b.ms - a.ms || a.week - b.week);
    return { totalWeeks: starts.length, leaders, longest: best, current, peaks: peaks.slice(0, limit) };
  }

  /**
   * Łączy dwa zbiory odsłuchów (np. stary eksport + nowszy) bez duplikatów.
   * Odsłuch to ten sam, gdy zgadza się czas, wykonawca, utwór i czas odtwarzania.
   */
  function mergeRows(oldRows, newRows) {
    const key = (r) => `${r.t}|${r.artist}|${r.track}|${r.ms}`;
    const seen = new Set(oldRows.map(key));
    const out = oldRows.slice();
    for (const r of newRows) {
      const k = key(r);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  // ────────────────────────────────────────────────────────── UTWÓR / ALBUM

  /** Szczegóły utworu lub albumu (kind: 'track' | 'album', key jak w top()). */
  function itemDetails(rows, kind, key) {
    const keyOf = KEYERS[kind];
    const own = rows.filter((r) => keyOf(r) === key);
    if (!own.length) return null;
    const s = summary(own, 0, 1);
    const days = new Map();
    let skips = 0;
    for (const r of own) {
      if (r.ms < MIN_STREAM_MS) { skips++; continue; }
      const d = startOfDay(r.t);
      days.set(d, (days.get(d) || 0) + 1);
    }
    let bestDay = null;
    for (const [day, plays] of days) if (!bestDay || plays > bestDay.plays) bestDay = { day, plays };
    const f = own[0];
    return {
      kind,
      key,
      name: kind === 'track' ? f.track : f.album,
      artist: f.artist,
      album: f.album,
      ms: s.ms,
      plays: s.plays,
      skips,
      days: days.size,
      first: f.t,
      last: own[own.length - 1].t,
      bestDay,
      tracks: kind === 'album' ? top(own, 'track', { limit: 0 }) : null,
      rows: own
    };
  }

  // ────────────────────────────────────────────────────────── PORÓWNANIE ZE ZNAJOMYM

  /**
   * Porównanie dwóch historii: zgodność gustu (0–100: wspólna część udziałów wykonawców w czasie słuchania),
   * wspólni wykonawcy i utwory (od najbardziej wspólnych), kto słucha więcej.
   */
  function compareUsers(aRows, bRows, { limit = 10 } = {}) {
    const side = (rows) => {
      const map = aggregate(rows, 'artist');
      let ms = 0;
      for (const e of map.values()) ms += e.ms;
      return { map, ms, tracks: aggregate(rows, 'track'), sum: summary(rows, 0, 1) };
    };
    const a = side(aRows);
    const b = side(bRows);
    const shared = (am, bm, aTot, bTot) => {
      const out = [];
      for (const [k, ea] of am) {
        const eb = bm.get(k);
        if (!eb) continue;
        const sa = aTot ? ea.ms / aTot : 0;
        const sb = bTot ? eb.ms / bTot : 0;
        out.push({ key: k, name: ea.name, artist: ea.artist, album: ea.album, a: { ms: ea.ms, plays: ea.plays, share: sa }, b: { ms: eb.ms, plays: eb.plays, share: sb }, overlap: Math.min(sa, sb) });
      }
      return out.sort((x, y) => y.overlap - x.overlap || (y.a.ms + y.b.ms) - (x.a.ms + x.b.ms));
    };
    const artists = shared(a.map, b.map, a.ms, b.ms);
    let tA = 0, tB = 0;
    for (const e of a.tracks.values()) tA += e.ms;
    for (const e of b.tracks.values()) tB += e.ms;
    const tracks = shared(a.tracks, b.tracks, tA, tB);
    const score = Math.round(artists.reduce((acc, x) => acc + x.overlap, 0) * 100);
    return {
      score,
      a: { ms: a.sum.ms, plays: a.sum.plays, artists: a.map.size },
      b: { ms: b.sum.ms, plays: b.sum.plays, artists: b.map.size },
      sharedArtists: artists.length,
      artists: limit ? artists.slice(0, limit) : artists,
      tracks: limit ? tracks.slice(0, limit) : tracks
    };
  }

  const API = {
    itemDetails,
    compareUsers,
    keyOf: (kind, r) => KEYERS[kind](r),
    rankSeries,
    mergeRows,
    records,
    listeningHours,
    rankTimeline,
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
