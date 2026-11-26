/*
 * SpotiStats — logika strony.
 *  • import .zip / .json z eksportu Spotify (JSZip)
 *  • zapis w IndexedDB (dane zostają między wizytami)
 *  • topki, wykresy w czasie, widok wykonawcy
 * Zwykły skrypt (nie moduł), żeby działało też z file://.
 */
(function () {
  'use strict';

  const A = window.SpotiAnalytics;
  const C = window.SpotiCharts;

  const IDB_NAME = 'SpotiStats';
  const IDB_VERSION = 2;
  const IDB_STORE = 'history';
  const IDB_KEY = 'me';
  const PREFS_KEY = 'ss_prefs';

  // Kolejność kolorów serii (paleta na ciemne tło, sprawdzona pod kątem daltonizmu).
  const SERIES_COLORS = ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'];
  const MAX_VISIBLE = SERIES_COLORS.length;
  const DEFAULT_VISIBLE = 5;

  const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

  // ─────────────────────────────────────────────────────── STAN
  const state = {
    rows: [],
    meta: null,
    range: '28d',
    year: null,
    sortBy: 'ms',
    topKind: 'artist',
    topUnit: null, // null = automatycznie
    visible: new Map(), // key -> kolor (dla wykresu top 10)
    visibleFor: '',
    artist: '',
    artistSpan: 'all',
    artistUnit: null
  };

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      for (const k of ['range', 'year', 'sortBy', 'topKind', 'artist', 'artistSpan']) if (p[k] != null) state[k] = p[k];
    } catch { /* brak dostępu do localStorage — trudno */ }
  }
  function savePrefs() {
    try {
      const { range, year, sortBy, topKind, artist, artistSpan } = state;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ range, year, sortBy, topKind, artist, artistSpan }));
    } catch { /* ignoruj */ }
  }

  // ─────────────────────────────────────────────────────── INDEXEDDB
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const req = fn(tx.objectStore(IDB_STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const saveData = (data) => idb('readwrite', (s) => s.put(data, IDB_KEY));
  const loadData = () => idb('readonly', (s) => s.get(IDB_KEY));
  const clearData = () => idb('readwrite', (s) => s.delete(IDB_KEY));

  // ─────────────────────────────────────────────────────── IMPORT
  async function readFiles(fileList) {
    const files = [];
    const errors = [];
    for (const file of fileList) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        if (typeof JSZip === 'undefined') { errors.push(`${file.name}: brak obsługi ZIP (nie wczytano jszip.min.js)`); continue; }
        let zip;
        try { zip = await JSZip.loadAsync(file); } catch { errors.push(`${file.name}: nie da się otworzyć archiwum ZIP`); continue; }
        for (const entry of Object.values(zip.files)) {
          if (entry.dir || A.classifyFile(entry.name) === 'skip') continue;
          try { files.push({ name: entry.name, data: JSON.parse(await entry.async('text')) }); }
          catch { errors.push(`${entry.name}: uszkodzony JSON`); }
        }
      } else if (lower.endsWith('.json')) {
        try { files.push({ name: file.name, data: JSON.parse(await file.text()) }); }
        catch { errors.push(`${file.name}: uszkodzony JSON`); }
      } else {
        errors.push(`${file.name}: nieobsługiwany typ pliku`);
      }
    }
    return { files, errors };
  }

  async function handleImport(fileList) {
    if (!fileList || !fileList.length) return;
    const status = document.getElementById('import-status');
    status.textContent = 'Wczytuję pliki…';
    status.classList.remove('import-status--error');
    try {
      const { files, errors } = await readFiles([...fileList]);
      const { rows, report } = A.combineFiles(files);
      if (!rows.length) {
        status.classList.add('import-status--error');
        status.textContent = report.format === 'none'
          ? 'Nie znalazłem plików z historią słuchania (Streaming_History_Audio_*.json albo StreamingHistory_music_*.json). Sprawdź, czy to eksport „Rozszerzonej historii strumieniowania”.'
          : 'W plikach nie ma żadnych odsłuchów muzyki.';
        if (errors.length) status.textContent += ` Błędy: ${errors.join('; ')}`;
        return;
      }
      const meta = { ...report, errors, importedAt: Date.now() };
      await saveData({ rows, meta });
      setData(rows, meta);
      status.textContent = '';
    } catch (err) {
      status.classList.add('import-status--error');
      status.textContent = `Błąd: ${err.message}`;
    }
  }

  // ─────────────────────────────────────────────────────── FORMATOWANIE
  const nf = new Intl.NumberFormat('pl-PL');
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const minutes = (ms) => Math.round(ms / 60_000);
  function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }
  function fmtSpan(from, to) {
    const a = new Date(from), b = new Date(to - 1);
    if (a.getFullYear() === b.getFullYear()) {
      const left = a.getMonth() === b.getMonth() ? `${a.getDate()}` : `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]}`;
      return `${left} – ${fmtDate(b.getTime())}`;
    }
    return `${fmtDate(from)} – ${fmtDate(b.getTime())}`;
  }

  // ─────────────────────────────────────────────────────── ZAKRES
  function currentBounds() {
    const rows = state.rows;
    const anchor = rows[rows.length - 1].t;
    return A.rangeBounds(state.range, anchor, { year: state.year, first: A.bucketStart(rows[0].t, 'day') });
  }

  function allowedUnits(from, to) {
    const days = (to - from) / 86_400_000;
    return { day: days <= 400, week: days >= 14, month: days >= 60 };
  }
  function pickUnit(chosen, from, to) {
    const allowed = allowedUnits(from, to);
    if (chosen && allowed[chosen]) return chosen;
    return A.defaultUnit(from, to);
  }
  function syncSeg(id, attr, value, allowed) {
    document.querySelectorAll(`#${id} button`).forEach((b) => {
      b.classList.toggle('is-active', b.dataset[attr] === value);
      b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
      if (allowed) b.disabled = !allowed[b.dataset[attr]];
    });
  }

  // ─────────────────────────────────────────────────────── RENDER
  function setData(rows, meta) {
    state.rows = rows;
    state.meta = meta;
    const years = A.yearsIn(rows);
    if (!years.includes(state.year)) state.year = years[0];
    document.getElementById('year-select').innerHTML = years.map((y) => `<option value="${y}">Rok ${y}</option>`).join('');
    document.getElementById('artist-list').innerHTML = A.allArtists(rows).map((a) => `<option value="${esc(a)}"></option>`).join('');
    state.visibleFor = '';
    render();
  }

  function render() {
    const has = state.rows.length > 0;
    document.getElementById('state-empty').classList.toggle('hidden', has);
    document.getElementById('state-data').classList.toggle('hidden', !has);
    document.getElementById('topbar-actions').classList.toggle('hidden', !has);
    if (!has) return;

    const m = state.meta || {};
    const parts = [`${nf.format(state.rows.length)} odsłuchów`];
    if (m.podcasts) parts.push(`${nf.format(m.podcasts)} podcastów pominiętych`);
    if (m.duplicates) parts.push(`${nf.format(m.duplicates)} duplikatów usuniętych`);
    document.getElementById('data-info').textContent = parts.join(' · ');
    document.getElementById('data-info').title = m.usedFiles ? `Wczytane pliki:\n${m.usedFiles.join('\n')}` : '';

    document.querySelectorAll('#range-pills .pill').forEach((p) => p.classList.toggle('pill--active', p.dataset.range === state.range));
    document.getElementById('year-select').value = String(state.year);
    document.querySelectorAll('#sort-pills .pill').forEach((p) => p.classList.toggle('pill--active', p.dataset.sort === state.sortBy));

    const { from, to } = currentBounds();
    const slice = A.sliceRange(state.rows, from, to);
    const lastTs = state.rows[state.rows.length - 1].t;
    let label = fmtSpan(from, to);
    if (state.range !== 'year' && state.range !== 'all') label += ` · liczone wstecz od ostatniego odsłuchu w eksporcie (${fmtDate(lastTs)})`;
    document.getElementById('range-label').textContent = label;

    renderKpis(slice, from, to);
    renderTops(slice);
    renderTopChart(slice, from, to);
    renderArtist(from, to);
  }

  function renderKpis(slice, from, to) {
    const s = A.summary(slice, from, to);
    const kpi = (label, value, sub) => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
    document.getElementById('kpi-row').innerHTML = [
      kpi('Minuty', nf.format(minutes(s.ms)), `${nf.format(Math.round(s.ms / 3_600_000))} godz.`),
      kpi('Odtworzenia', nf.format(s.plays), 'co najmniej 30 s'),
      kpi('Wykonawcy', nf.format(s.artists)),
      kpi('Utwory', nf.format(s.tracks)),
      kpi('Średnio dziennie', `${nf.format(Math.round(s.minutesPerDay))} min`)
    ].join('');
  }

  function barList(items, kind) {
    if (!items.length) return '<p class="no-data">Brak odsłuchów w tym zakresie.</p>';
    const metric = state.sortBy === 'plays' ? 'plays' : 'ms';
    const max = Math.max(...items.map((i) => i[metric]), 1);
    return `<ol class="bar-list">${items.map((it, i) => {
      const pct = Math.max((it[metric] / max) * 100, 2);
      const sub = kind === 'artist' ? '' : `<span class="bar-sub">${esc(it.artist)}</span>`;
      const meta = `${nf.format(minutes(it.ms))} min · ${nf.format(it.plays)}×`;
      const clickable = kind === 'artist' ? ` data-artist="${esc(it.name)}" tabindex="0" role="button" title="Pokaż wykres: ${esc(it.name)}"` : '';
      return `<li class="bar-item${kind === 'artist' ? ' bar-item--link' : ''}"${clickable}>
        <div class="bar-top"><span class="bar-rank">${i + 1}</span><span class="bar-name">${esc(it.name)}${sub}</span><span class="bar-meta">${meta}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </li>`;
    }).join('')}</ol>`;
  }

  function renderTops(slice) {
    const opts = { sortBy: state.sortBy, limit: 10 };
    document.getElementById('top-artists').innerHTML = barList(A.top(slice, 'artist', opts), 'artist');
    document.getElementById('top-tracks').innerHTML = barList(A.top(slice, 'track', opts), 'track');
    document.getElementById('top-albums').innerHTML = barList(A.top(slice, 'album', opts), 'album');
  }

  /** Kolory trzymają się danej pozycji (nie miejsca w rankingu), dopóki jest widoczna. */
  function ensureVisible(items, signature) {
    if (state.visibleFor === signature) {
      for (const key of [...state.visible.keys()]) if (!items.some((i) => i.key === key)) state.visible.delete(key);
      return;
    }
    state.visibleFor = signature;
    state.visible = new Map();
    items.slice(0, DEFAULT_VISIBLE).forEach((it, i) => state.visible.set(it.key, SERIES_COLORS[i]));
  }
  function freeColor() {
    const used = new Set(state.visible.values());
    return SERIES_COLORS.find((c) => !used.has(c));
  }

  function renderTopChart(slice, from, to) {
    const kind = state.topKind;
    const unit = pickUnit(state.topUnit, from, to);
    syncSeg('top-kind', 'kind', kind);
    syncSeg('top-unit', 'unit', unit, allowedUnits(from, to));

    const items = A.top(slice, kind, { sortBy: state.sortBy, limit: 10 });
    ensureVisible(items, `${kind}|${state.range}|${state.year}|${state.sortBy}`);

    const legend = document.getElementById('top-legend');
    legend.innerHTML = items.map((it, i) => {
      const color = state.visible.get(it.key);
      const name = kind === 'track' ? `${it.name} — ${it.artist}` : it.name;
      return `<button type="button" class="legend-item${color ? '' : ' is-off'}" data-key="${esc(it.key)}" aria-pressed="${Boolean(color)}">
        <span class="swatch" style="${color ? `background:${color}` : ''}"></span><span class="legend-rank">${i + 1}.</span> ${esc(name)}</button>`;
    }).join('');

    const shown = items.filter((it) => state.visible.has(it.key));
    const keyOf = kind === 'track' ? A.trackKey : (r) => r.artist;
    const tl = A.timeline(slice, from, to, unit, shown.map((it) => ({ key: it.key, match: (r) => keyOf(r) === it.key })));
    C.lineChart(document.getElementById('top-chart'), {
      buckets: tl.buckets,
      unit,
      series: shown.map((it, i) => ({ name: kind === 'track' ? `${it.name} — ${it.artist}` : it.name, color: state.visible.get(it.key), values: tl.series[i].values }))
    });
    if (!items.length) document.getElementById('top-chart').innerHTML = '<p class="no-data">Brak odsłuchów w tym zakresie.</p>';
    else if (!shown.length) document.getElementById('top-chart').innerHTML = '<p class="no-data">Zaznacz kogoś w legendzie.</p>';
  }

  function renderArtist(rangeFrom, rangeTo) {
    const body = document.getElementById('artist-body');
    const input = document.getElementById('artist-search');
    if (document.activeElement !== input) input.value = state.artist;
    syncSeg('artist-span', 'span', state.artistSpan);

    if (!state.artist) {
      const first = A.top(A.sliceRange(state.rows, rangeFrom, rangeTo), 'artist', { limit: 1 })[0];
      if (first) state.artist = first.name;
      input.value = state.artist;
    }
    const details = A.artistDetails(state.rows, state.artist);
    if (!details.first) {
      syncSeg('artist-unit', 'unit', '', { day: false, week: false, month: false });
      body.innerHTML = state.artist
        ? `<p class="no-data">Nie ma „${esc(state.artist)}” w Twojej historii. Wybierz z podpowiedzi.</p>`
        : '<p class="no-data">Wpisz wykonawcę albo kliknij go w topce.</p>';
      return;
    }

    let from, to;
    if (state.artistSpan === 'range') ({ from, to } = { from: rangeFrom, to: rangeTo });
    else { from = A.bucketStart(details.first, 'day'); to = A.bucketStart(state.rows[state.rows.length - 1].t, 'day') + 86_400_000; }
    const unit = pickUnit(state.artistUnit || 'week', from, to);
    syncSeg('artist-unit', 'unit', unit, allowedUnits(from, to));

    const inRange = A.sliceRange(state.rows, rangeFrom, rangeTo).filter((r) => r.artist === state.artist);
    const rangeStats = A.summary(inRange, rangeFrom, rangeTo);
    const tops = A.top(inRange, 'track', { sortBy: state.sortBy, limit: 10 });

    body.innerHTML = `
      <div class="artist-head">
        <h3 class="artist-name">${esc(details.artist)}</h3>
        <dl class="artist-facts">
          <div><dt>Łącznie</dt><dd>${nf.format(minutes(details.ms))} min · ${nf.format(details.plays)}×</dd></div>
          <div><dt>W wybranym zakresie</dt><dd>${nf.format(minutes(rangeStats.ms))} min · ${nf.format(rangeStats.plays)}×</dd></div>
          <div><dt>Pierwszy odsłuch</dt><dd>${fmtDate(details.first)}</dd></div>
          <div><dt>Ostatni odsłuch</dt><dd>${fmtDate(details.last)}</dd></div>
        </dl>
      </div>
      <div id="artist-chart"></div>
      <h4 class="sub-title">Najczęściej słuchane utwory (wybrany zakres)</h4>
      <div id="artist-tracks">${barList(tops, 'track')}</div>`;

    const own = state.rows.filter((r) => r.artist === state.artist);
    const tl = A.timeline(own, from, to, unit, [{ key: state.artist, match: () => true }]);
    C.lineChart(document.getElementById('artist-chart'), {
      buckets: tl.buckets,
      unit,
      area: true,
      series: [{ name: state.artist, color: SERIES_COLORS[0], values: tl.series[0].values }]
    });
  }

  function selectArtist(name, scroll) {
    state.artist = name;
    savePrefs();
    const { from, to } = currentBounds();
    renderArtist(from, to);
    if (scroll) document.getElementById('artist-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─────────────────────────────────────────────────────── DEMO
  function demoRows() {
    const artists = [
      ['Taco Hemingway', ['Następna stacja', 'Polskie tango', 'Deszcz na betonie']],
      ['Daft Punk', ['Get Lucky', 'One More Time', 'Instant Crush']],
      ['Dawid Podsiadło', ['Małomiasteczkowy', 'Nie ma fal', 'Post']],
      ['Tame Impala', ['The Less I Know The Better', 'Borderline']],
      ['Dua Lipa', ['Levitating', 'Houdini']],
      ['Arctic Monkeys', ['Do I Wanna Know?', '505']],
      ['sanah', ['Szampan', 'Ten Stan']],
      ['The Weeknd', ['Blinding Lights', 'Save Your Tears']],
      ['Kendrick Lamar', ['HUMBLE.', 'Not Like Us']],
      ['Mata', ['Patointeligencja', 'Kiss cam']],
      ['Billie Eilish', ['BIRDS OF A FEATHER', 'bad guy']],
      ['Fred again..', ['Delilah', 'Marea']]
    ];
    const now = Date.now();
    const rows = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let day = 730; day >= 0; day--) {
      const phase = day / 730;
      const n = 3 + Math.floor(rnd() * 14);
      for (let k = 0; k < n; k++) {
        // Gusta zmieniają się w czasie — żeby wykresy miały co pokazać.
        const weights = artists.map((_, i) => Math.max(0.05, 1 / (i + 1) + (i % 3 === 0 ? (1 - phase) * 0.6 : i % 3 === 1 ? phase * 0.5 : Math.sin(phase * 9 + i) * 0.2)));
        let pick = rnd() * weights.reduce((a, b) => a + b, 0), i = 0;
        while ((pick -= weights[i]) > 0) i++;
        const [artist, tracks] = artists[i];
        const track = tracks[Math.floor(rnd() * tracks.length)];
        const ms = rnd() < 0.15 ? 3000 + Math.floor(rnd() * 20000) : 140000 + Math.floor(rnd() * 100000);
        rows.push({ t: now - day * 86_400_000 - Math.floor(rnd() * 86_400_000), artist, track, album: `${artist} — album`, uri: `demo:${artist}:${track}`, ms });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  // ─────────────────────────────────────────────────────── ZDARZENIA
  function wire() {
    const dropZone = document.getElementById('drop-zone');
    const input = document.getElementById('import-files');
    input.addEventListener('change', (e) => { handleImport(e.target.files); e.target.value = ''; });
    dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); handleImport(e.dataTransfer.files); });

    document.getElementById('reimport-files').addEventListener('change', (e) => { handleImport(e.target.files); e.target.value = ''; });

    document.getElementById('btn-clear-data').addEventListener('click', async () => {
      if (!confirm('Usunąć wczytaną historię z tej przeglądarki?')) return;
      try { await clearData(); } catch { /* ignoruj */ }
      state.rows = [];
      state.meta = null;
      render();
    });

    document.getElementById('btn-load-demo').addEventListener('click', () => {
      const rows = demoRows();
      setData(rows, { demo: true, usedFiles: ['dane przykładowe'] });
    });

    document.getElementById('range-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('button.pill');
      if (!pill) return;
      state.range = pill.dataset.range;
      savePrefs();
      render();
    });
    const yearSelect = document.getElementById('year-select');
    yearSelect.addEventListener('change', () => { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); render(); });
    yearSelect.addEventListener('click', () => { if (state.range !== 'year') { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); render(); } });

    document.getElementById('sort-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('button.pill');
      if (!pill) return;
      state.sortBy = pill.dataset.sort;
      savePrefs();
      render();
    });

    document.getElementById('top-kind').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.topKind = b.dataset.kind;
      savePrefs();
      render();
    });
    document.getElementById('top-unit').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      state.topUnit = b.dataset.unit;
      render();
    });
    document.getElementById('top-legend').addEventListener('click', (e) => {
      const b = e.target.closest('.legend-item');
      if (!b) return;
      const key = b.dataset.key;
      if (state.visible.has(key)) state.visible.delete(key);
      else if (state.visible.size < MAX_VISIBLE) state.visible.set(key, freeColor());
      else return;
      const { from, to } = currentBounds();
      renderTopChart(A.sliceRange(state.rows, from, to), from, to);
    });

    const onArtistPick = (e) => {
      const el = e.target.closest('[data-artist]');
      if (el) selectArtist(el.dataset.artist, true);
    };
    document.getElementById('top-artists').addEventListener('click', onArtistPick);
    document.getElementById('top-artists').addEventListener('keydown', (e) => { if (e.key === 'Enter') onArtistPick(e); });

    const search = document.getElementById('artist-search');
    const commit = () => {
      const v = search.value.trim();
      if (!v) return;
      // Dopasowanie bez względu na wielkość liter.
      const match = A.allArtists(state.rows).find((a) => a.toLowerCase() === v.toLowerCase()) || v;
      selectArtist(match, false);
    };
    search.addEventListener('change', commit);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    document.getElementById('artist-span').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.artistSpan = b.dataset.span;
      savePrefs();
      const { from, to } = currentBounds();
      renderArtist(from, to);
    });
    document.getElementById('artist-unit').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      state.artistUnit = b.dataset.unit;
      const { from, to } = currentBounds();
      renderArtist(from, to);
    });

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.rows.length) render(); }, 150);
    });
  }

  async function init() {
    loadPrefs();
    wire();
    try {
      const stored = await loadData();
      if (stored && stored.rows && stored.rows.length) { setData(stored.rows, stored.meta); return; }
    } catch { /* IndexedDB niedostępne — zaczynamy od zera */ }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
