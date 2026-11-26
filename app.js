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
  const PREFS_KEY = 'ss_prefs';
  /** Konto nr 1 zostaje pod starym kluczem, żeby nie zgubić wczytanego już eksportu. */
  const idbKey = (slot) => (slot === 1 ? 'me' : `konto-${slot}`);
  const SPOTIFY_GREEN = '#1ed760';

  // Kolejność kolorów serii (paleta na ciemne tło, sprawdzona pod kątem daltonizmu).
  const SERIES_COLORS = ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef', '#eb6263'];
  const MAX_VISIBLE = SERIES_COLORS.length;
  const DEFAULT_VISIBLE = 5;

  const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

  // ─────────────────────────────────────────────────────── STAN
  const state = {
    rows: [],
    exportRows: [],
    liveRows: [],
    liveStatus: null,
    liveAdded: 0,
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
    artistUnit: null,
    showMore: false, // topki: 10 pozycji albo 25
    kingsUnit: null, // null = automatycznie (tygodnie do roku, dłużej miesiące)
    slot: 1,
    accounts: null, // z konta.json (null = jeszcze nie wczytane / brak sieci)
    liveCache: new Map(), // slot -> znormalizowane wiersze z automatu
    images: new Map(), // nazwa wykonawcy małymi literami -> url zdjęcia (z automatu)
    covers: new Map(), // „wykonawca|album” małymi literami -> url okładki
    imagesReady: new Set() // adresy zdjęć już wczytanych (tylko te pokazujemy — bez migania)
  };

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      for (const k of ['range', 'year', 'sortBy', 'topKind', 'artist', 'artistSpan', 'slot']) if (p[k] != null) state[k] = p[k];
      const q = Number(new URLSearchParams(location.search).get('konto'));
      if (q >= 1 && q <= 5) state.slot = q;
    } catch { /* brak dostępu do localStorage — trudno */ }
  }
  function savePrefs() {
    try {
      const { range, year, sortBy, topKind, artist, artistSpan, slot } = state;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ range, year, sortBy, topKind, artist, artistSpan, slot }));
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
  const saveData = (slot, data) => idb('readwrite', (s) => s.put(data, idbKey(slot)));
  const loadData = (slot) => idb('readonly', (s) => s.get(idbKey(slot)));
  const clearData = (slot) => idb('readwrite', (s) => s.delete(idbKey(slot)));

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
      await saveData(state.slot, { rows, meta });
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

  // ─────────────────────────────────────────────────────── AWATARY I KONTA
  function hueOf(name) {
    // FNV-1a + mieszanie, żeby podobne nazwy („Artist A”, „Artist B”) dostawały wyraźnie różne kolory.
    let h = 0x811c9dc5;
    for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
    return h % 360;
  }
  function initials(name) {
    const parts = String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '♪';
    return (parts[0][0] + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
  }
  function avatar(name, cls = '') {
    return `<span class="avatar ${cls}" style="--h:${hueOf(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  }
  /** Zdjęcie wykonawcy, jeśli automat je zdobył — inaczej kolorowe inicjały. */
  function artistAvatar(name, cls = '') {
    const img = state.images.get(String(name).toLowerCase());
    if (!img || !state.imagesReady.has(img)) return avatar(name, cls);
    return `<span class="avatar avatar--img ${cls}" style="--h:${hueOf(name)}" aria-hidden="true"><img src="${esc(img)}" alt="" decoding="sync" referrerpolicy="no-referrer" onerror="this.remove()" />${esc(initials(name))}</span>`;
  }
  /** Okładka albumu (utworu / albumu), jeśli automat ją zdobył — inaczej kolorowe inicjały. */
  function coverAvatar(title, artist, album, cls = '') {
    const img = album ? state.covers.get(`${String(artist).toLowerCase()}|${String(album).toLowerCase()}`) : null;
    if (!img || !state.imagesReady.has(img)) return avatar(title, cls);
    return `<span class="avatar avatar--img ${cls}" style="--h:${hueOf(title)}" aria-hidden="true"><img src="${esc(img)}" alt="" decoding="sync" referrerpolicy="no-referrer" onerror="this.remove()" />${esc(initials(title))}</span>`;
  }
  /** Wczytuje zdjęcia w tle; strona przerysowuje się raz, gdy są gotowe (nie co zdjęcie). */
  function preloadImages(urls, limit = 200, timeoutMs = 6000) {
    const jobs = [...new Set(urls)].slice(0, limit).map((url) => new Promise((resolve) => {
      const im = new Image();
      im.referrerPolicy = 'no-referrer';
      im.onload = () => { state.imagesReady.add(url); resolve(); };
      im.onerror = () => resolve();
      im.src = url;
    }));
    return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  function accountOf(slot) {
    return (state.accounts || []).find((a) => a.slot === slot) || { slot, name: null };
  }
  function accountName(slot) {
    const a = accountOf(slot);
    if (a.name) return a.name;
    if (a.connectedAt) return slot === 1 ? 'Ty' : `Konto ${slot}`;
    return slot === 1 ? 'Ty' : null;
  }
  function slotHasData(slot) {
    return Boolean(accountOf(slot).connectedAt) || slot === state.slot && state.exportRows.length > 0;
  }

  function renderAccounts() {
    const list = document.getElementById('account-list');
    const items = [];
    for (let slot = 1; slot <= 5; slot++) {
      const name = accountName(slot);
      const a = accountOf(slot);
      const active = slot === state.slot;
      const sub = a.connectedAt ? (a.error ? 'automat: błąd' : 'automat działa') : name ? 'tylko eksport' : 'wolne miejsce';
      items.push(`<li><button type="button" class="account${active ? ' is-active' : ''}${name ? '' : ' is-empty'}" data-slot="${slot}" aria-current="${active}">
        ${name ? avatar(name, 'avatar--sm') : '<span class="avatar avatar--sm avatar--empty" aria-hidden="true">+</span>'}
        <span class="account-text"><span class="account-name">${esc(name || `Wolne miejsce ${slot}`)}</span><span class="account-sub">${sub}</span></span>
      </button></li>`);
    }
    list.innerHTML = items.join('');
  }

  // ─────────────────────────────────────────────────────── RENDER
  /** Eksport (z IndexedDB) + odsłuchy dociągnięte automatem, tylko te nowsze niż koniec eksportu. */
  function setData(rows, meta) {
    state.exportRows = rows;
    state.meta = meta;
    recombine();
  }

  function recombine() {
    const exp = state.exportRows;
    const exportEnd = exp.length ? exp[exp.length - 1].t : -Infinity;
    const live = state.liveCache.get(state.slot) || [];
    // Demo nie miesza się z prawdziwymi danymi.
    const extra = state.meta && state.meta.demo ? [] : live.filter((r) => r.t > exportEnd);
    state.liveAdded = extra.length;
    const rows = extra.length ? exp.concat(extra) : exp; // obie listy posortowane, a extra jest później
    state.rows = rows;
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
    document.body.classList.toggle('has-data', has);
    renderAccounts();
    renderLiveBanner();
    if (!has) { renderEmpty(); renderHero(null); return; }

    const m = state.meta || {};
    const parts = [`${nf.format(state.rows.length)} odsłuchów`];
    if (state.liveAdded) parts.push(`w tym ${nf.format(state.liveAdded)} z automatu`);
    if (m.podcasts) parts.push(`${nf.format(m.podcasts)} podcastów pominiętych`);
    if (m.duplicates) parts.push(`${nf.format(m.duplicates)} duplikatów usuniętych`);
    document.getElementById('data-info').textContent = parts.join(' · ');
    document.getElementById('data-info').title = m.usedFiles ? `Wczytane pliki:\n${m.usedFiles.join('\n')}` : '';

    document.querySelectorAll('#range-pills .chip').forEach((p) => p.classList.toggle('is-active', p.dataset.range === state.range));
    document.getElementById('year-select').value = String(state.year);
    document.querySelectorAll('#sort-pills .chip').forEach((p) => p.classList.toggle('is-active', p.dataset.sort === state.sortBy));

    const { from, to } = currentBounds();
    const slice = A.sliceRange(state.rows, from, to);
    const lastTs = state.rows[state.rows.length - 1].t;
    let label = fmtSpan(from, to);
    if (state.range !== 'year' && state.range !== 'all') label += ` · liczone wstecz od ostatniego odsłuchu (${fmtDate(lastTs)})`;
    document.getElementById('range-label').textContent = label;

    const sum = A.summary(slice, from, to);
    renderHero(sum);
    renderKpis(sum);
    renderTops(slice);
    renderKings(slice, from, to);
    renderWhen(slice);
    renderTopChart(slice, from, to);
    renderArtist(from, to);
  }

  const RANGE_NAMES = { '7d': 'w ostatnich 7 dniach', '28d': 'w ostatnich 28 dniach', '6m': 'w ostatnim półroczu', all: 'od początku' };

  function renderHero(sum) {
    const name = state.meta && state.meta.demo ? 'Dane przykładowe' : accountName(state.slot) || `Wolne miejsce ${state.slot}`;
    document.getElementById('hero-name').textContent = name;
    document.getElementById('hero-avatar').outerHTML = `<div id="hero-avatar" class="avatar avatar--xl" style="--h:${hueOf(name)}" aria-hidden="true">${esc(initials(name))}</div>`;
    document.getElementById('hero').style.setProperty('--h', hueOf(name));
    const when = state.range === 'year' ? `w ${state.year} roku` : RANGE_NAMES[state.range];
    document.getElementById('hero-sub').textContent = sum
      ? `${nf.format(minutes(sum.ms))} minut · ${nf.format(sum.plays)} odtworzeń · ${nf.format(sum.artists)} wykonawców ${when}`
      : 'Brak danych dla tego konta';
  }

  function renderKpis(s) {
    const kpi = (label, value, sub) => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
    document.getElementById('kpi-row').innerHTML = [
      kpi('Minuty', nf.format(minutes(s.ms)), `${nf.format(Math.round(s.ms / 3_600_000))} godz.`),
      kpi('Odtworzenia', nf.format(s.plays), 'co najmniej 30 s'),
      kpi('Wykonawcy', nf.format(s.artists)),
      kpi('Utwory', nf.format(s.tracks)),
      kpi('Średnio dziennie', `${nf.format(Math.round(s.minutesPerDay))} min`)
    ].join('');
  }

  const valueOf = (it) => (state.sortBy === 'plays' ? `${nf.format(it.plays)} odtw.` : `${nf.format(minutes(it.ms))} min`);

  /** Pozycje z poprzedniego, równie długiego okresu (do strzałek ▲▼). Dla „cały czas” brak porównania. */
  function previousRanks(kind) {
    if (state.range === 'all') return null;
    const { from, to } = currentBounds();
    const prev = A.sliceRange(state.rows, from - (to - from), from);
    if (!prev.length) return null;
    const map = new Map();
    A.top(prev, kind, { sortBy: state.sortBy, limit: 0 }).forEach((it, i) => map.set(it.key, i + 1));
    return map;
  }
  /** Zmiana pozycji względem poprzedniego okresu: ▲2, ▼1, „nowy”. */
  function delta(prev, it, i) {
    if (!prev) return '';
    const before = prev.get(it.key);
    if (before == null) return '<span class="delta delta--new" title="Nie było w poprzednim okresie">nowy</span>';
    const d = before - (i + 1);
    if (!d) return '<span class="delta delta--same" title="Bez zmian">–</span>';
    return `<span class="delta ${d > 0 ? 'delta--up' : 'delta--down'}" title="Poprzednio miejsce ${before}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>`;
  }

  /** Lista w stylu tracklisty: numer, okładka, tytuł + wykonawca, wartość. */
  function trackList(items, kind, prev) {
    if (!items.length) return '<p class="no-data">Brak odsłuchów w tym zakresie.</p>';
    return `<ol class="tracklist">${items.map((it, i) => {
      const other = state.sortBy === 'plays' ? `${nf.format(minutes(it.ms))} min` : `${nf.format(it.plays)} odtw.`;
      return `<li class="track-row" data-artist="${esc(it.artist)}" tabindex="0" role="button" title="Pokaż wykres: ${esc(it.artist)}">
        <span class="track-rank">${i + 1}${delta(prev, it, i)}</span>
        ${coverAvatar(kind === 'album' ? it.name : `${it.name} ${it.artist}`, it.artist, kind === 'album' ? it.name : it.album, 'avatar--cover')}
        <span class="track-text"><span class="track-name">${esc(it.name)}</span><span class="track-sub">${esc(it.artist)}</span></span>
        <span class="track-val" title="${other}">${valueOf(it)}</span>
      </li>`;
    }).join('')}</ol>`;
  }

  function artistGrid(items, prev) {
    if (!items.length) return '<p class="no-data">Brak odsłuchów w tym zakresie.</p>';
    return items.map((it, i) => `<button type="button" class="artist-card" data-artist="${esc(it.name)}" title="Pokaż wykres: ${esc(it.name)}">
        ${artistAvatar(it.name, 'avatar--lg')}
        <span class="artist-card__name"><span class="artist-card__rank">${i + 1}.</span> ${esc(it.name)}</span>
        <span class="artist-card__sub">${valueOf(it)} ${delta(prev, it, i)}</span>
      </button>`).join('');
  }

  function renderTops(slice) {
    const limit = state.showMore ? 25 : 10;
    const opts = { sortBy: state.sortBy, limit };
    const more = (n) => (n > 10 ? `<button type="button" class="more-btn" data-more>${state.showMore ? 'Pokaż mniej' : 'Pokaż więcej'}</button>` : '');
    const artists = A.top(slice, 'artist', opts);
    const tracks = A.top(slice, 'track', opts);
    const albums = A.top(slice, 'album', opts);
    const total = (kind) => A.top(slice, kind, { sortBy: state.sortBy, limit: 0 }).length;
    document.getElementById('top-artists').innerHTML = artistGrid(artists, previousRanks('artist'));
    document.getElementById('top-artists-more').innerHTML = more(total('artist'));
    document.getElementById('top-tracks').innerHTML = trackList(tracks, 'track', previousRanks('track')) + more(total('track'));
    document.getElementById('top-albums').innerHTML = trackList(albums, 'album', previousRanks('album')) + more(total('album'));
  }

  // ─────────────────────────────────────────────────────── KIEDY SŁUCHASZ
  const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
  const DAY_FULL = ['w poniedziałki', 'we wtorki', 'w środy', 'w czwartki', 'w piątki', 'w soboty', 'w niedziele'];
  function bars(values, labels, peak, labelEvery = 1, fmt) {
    const max = Math.max(1, ...values);
    return values.map((v, i) => `<div class="bar${i === peak ? ' is-peak' : ''}" title="${esc(fmt(i, v))}">
      <span class="bar__fill" style="height:${Math.max(v ? 3 : 0, (v / max) * 100)}%"></span>
      <span class="bar__label">${i % labelEvery === 0 ? labels[i] : ''}</span></div>`).join('');
  }
  function renderWhen(slice) {
    const r = A.listeningHours(slice);
    const hourLabels = Array.from({ length: 24 }, (_, h) => String(h));
    const hh = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
    document.getElementById('when-hours').innerHTML = bars(r.hours, hourLabels, r.peakHour, 3, (i, v) => `${hh(i)} · ${nf.format(minutes(v))} min`);
    document.getElementById('when-days').innerHTML = bars(r.days, DAY_NAMES, r.peakDay, 1, (i, v) => `${DAY_NAMES[i]} · ${nf.format(minutes(v))} min`);
    document.getElementById('when-summary').textContent = r.total
      ? `Najwięcej słuchasz koło ${String(r.peakHour).padStart(2, '0')}:00, ${DAY_FULL[r.peakDay]}`
      : '';
  }

  // ─────────────────────────────────────────────────────── NR 1 TYGODNIA
  const KINGS_DEPTH = 5;
  function renderKings(slice, from, to) {
    const span = (to - from) / 86_400_000;
    const allowed = { week: span >= 14, month: span >= 60 };
    const auto = allowed.month ? 'month' : 'week';
    const unit = state.kingsUnit && allowed[state.kingsUnit] ? state.kingsUnit : auto;
    syncSeg('kings-unit', 'unit', unit, allowed);
    const r = A.rankTimeline(slice, from, to, unit, { depth: KINGS_DEPTH, limit: span > 730 ? 4 : 5, sortBy: state.sortBy, outside: true });
    const unitWord = unit === 'month' ? ['miesiąc', 'miesiące', 'miesięcy', 'w tym miesiącu'] : ['tydzień', 'tygodnie', 'tygodni', 'w tym tygodniu'];
    const plural = (n) => (n === 1 ? unitWord[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? unitWord[1] : unitWord[2]);

    // Aktualny nr 1 i jego seria z rzędu
    const lastIdx = r.leaders.map((l, i) => (l ? i : -1)).filter((i) => i >= 0).pop();
    const now = lastIdx != null ? r.leaders[lastIdx] : null;
    let streak = 0;
    if (now) for (let i = lastIdx; i >= 0 && r.leaders[i] && r.leaders[i].name === now.name; i--) streak++;
    document.getElementById('kings-now').innerHTML = now
      ? `<button type="button" class="kings-now__card" data-artist="${esc(now.name)}">${artistAvatar(now.name, 'avatar--lg')}
          <span><span class="kicker">Nr 1 ${lastIdx === r.leaders.length - 1 ? unitWord[3] : 'ostatnio'}</span>
          <span class="kings-now__name">${esc(now.name)}</span>
          <span class="kings-now__sub">${streak > 1 ? `${streak} ${plural(streak)} z rzędu · ` : ''}${nf.format(minutes(now.ms))} min</span></span></button>`
      : '<p class="no-data">Brak odsłuchów.</p>';

    const maxW = Math.max(1, ...r.kings.map((k) => k.weeks));
    document.getElementById('kings-list').innerHTML = r.kings.slice(0, 8).map((k) =>
      `<li class="kings-row" data-artist="${esc(k.name)}" tabindex="0" role="button">
        ${artistAvatar(k.name, 'avatar--sm')}<span class="kings-row__name">${esc(k.name)}</span>
        <span class="kings-row__bar"><span style="width:${(k.weeks / maxW) * 100}%"></span></span>
        <span class="kings-row__val">${k.weeks} ${plural(k.weeks)}</span></li>`).join('') || '<li class="no-data">—</li>';

    const colors = new Map(r.series.map((s, i) => [s.key, SERIES_COLORS[i]]));
    document.getElementById('kings-legend').innerHTML = r.series.map((s) =>
      `<span class="legend-item legend-item--static"><span class="swatch" style="background:${colors.get(s.key)}"></span>${esc(s.key)}</span>`).join('');
    const chartEl = document.getElementById('kings-chart');
    if (r.buckets.length < 3) {
      chartEl.innerHTML = `<p class="no-data">Za krótki zakres na wykres — wybierz pół roku, rok albo cały czas.</p>`;
      return;
    }
    C.lineChart(chartEl, {
      buckets: r.buckets,
      unit,
      rank: true,
      rankOut: true,
      maxRank: KINGS_DEPTH + 1,
      height: 260,
      series: r.series.map((s) => ({ name: s.key, color: colors.get(s.key), values: s.values })),
      tipExtra: (i) => (r.leaders[i] ? `<div class="chart-tip__lead">👑 ${esc(r.leaders[i].name)} · ${nf.format(minutes(r.leaders[i].ms))} min</div>` : '')
    });
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
        <div class="artist-id">${artistAvatar(details.artist, 'avatar--lg')}<h3 class="artist-name">${esc(details.artist)}</h3></div>
        <dl class="artist-facts">
          <div><dt>Łącznie</dt><dd>${nf.format(minutes(details.ms))} min · ${nf.format(details.plays)}×</dd></div>
          <div><dt>W wybranym zakresie</dt><dd>${nf.format(minutes(rangeStats.ms))} min · ${nf.format(rangeStats.plays)}×</dd></div>
          <div><dt>Pierwszy odsłuch</dt><dd>${fmtDate(details.first)}</dd></div>
          <div><dt>Ostatni odsłuch</dt><dd>${fmtDate(details.last)}</dd></div>
        </dl>
      </div>
      <div id="artist-chart"></div>
      <h4 class="sub-title">Najczęściej słuchane utwory (wybrany zakres)</h4>
      <div id="artist-tracks">${trackList(tops, 'track')}</div>`;

    const own = state.rows.filter((r) => r.artist === state.artist);
    const tl = A.timeline(own, from, to, unit, [{ key: state.artist, match: () => true }]);
    C.lineChart(document.getElementById('artist-chart'), {
      buckets: tl.buckets,
      unit,
      area: true,
      series: [{ name: state.artist, color: SPOTIFY_GREEN, values: tl.series[0].values }]
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
      try { await clearData(state.slot); } catch { /* ignoruj */ }
      state.meta = null;
      setData([], null);
    });

    document.getElementById('btn-load-demo').addEventListener('click', () => {
      const rows = demoRows();
      state.artist = '';
      setData(rows, { demo: true, usedFiles: ['dane przykładowe'] });
    });

    document.getElementById('range-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('button.chip');
      if (!pill) return;
      state.range = pill.dataset.range;
      savePrefs();
      render();
    });
    const yearSelect = document.getElementById('year-select');
    yearSelect.addEventListener('change', () => { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); render(); });
    yearSelect.addEventListener('click', () => { if (state.range !== 'year') { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); render(); } });

    document.getElementById('sort-pills').addEventListener('click', (e) => {
      const pill = e.target.closest('button.chip');
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
    for (const id of ['top-artists', 'top-tracks', 'top-albums', 'kings-now', 'kings-list', 'artist-tracks-wrap']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('click', onArtistPick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') onArtistPick(e); });
    }

    document.getElementById('state-data').addEventListener('click', (e) => {
      if (!e.target.closest('[data-more]')) return;
      state.showMore = !state.showMore;
      const { from, to } = currentBounds();
      renderTops(A.sliceRange(state.rows, from, to));
    });

    document.getElementById('kings-unit').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      state.kingsUnit = b.dataset.unit;
      savePrefs();
      render();
    });

    document.getElementById('account-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-slot]');
      if (!b) return;
      const slot = Number(b.dataset.slot);
      if (slot !== state.slot) loadSlot(slot);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    document.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Skopiowano ✓'; } catch { /* ignoruj */ }
    });

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

  // ─────────────────────────────────────────────────────── KONTA I AUTOMAT (gałąź „dane”)
  function pageUrl(path) {
    return new URL(path, location.href).href.replace(/\?.*$/, '');
  }

  function renderEmpty() {
    const slot = state.slot;
    const free = !accountName(slot);
    document.getElementById('empty-title').textContent = slot === 1
      ? 'Wczytaj swoją historię ze Spotify'
      : free ? `Wolne miejsce nr ${slot}` : `Wczytaj eksport: ${accountName(slot)}`;
    const help = document.getElementById('friend-help');
    help.classList.toggle('hidden', slot === 1);
    if (slot === 1) return;
    const link = `${pageUrl('./spotify.html')}?konto=${slot}`;
    help.innerHTML = `
      <h3>Jak podłączyć tu znajomego (automat)</h3>
      <ol>
        <li>Na <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> otwórz swoją aplikację → <b>User Management</b> i dopisz imię oraz e-mail jego konta Spotify.</li>
        <li>Wyślij mu ten link — zaloguje się i dostanie kod:
          <span class="copy-row"><input class="field-input" readonly value="${esc(link)}" /><button type="button" class="btn btn--outline btn--sm" data-copy="${esc(link)}">Kopiuj</button></span></li>
        <li>Kod, który Ci odeśle, wklej w <a href="${esc(window.SpotiLive ? window.SpotiLive.actionsUrl() : '#')}" target="_blank" rel="noopener">Run workflow</a>, wybierz konto <b>${slot}</b> i wpisz jego imię.</li>
      </ol>
      <p class="setup-note">Możesz też po prostu wrzucić tu jego plik .zip z eksportem — zostanie tylko w Twojej przeglądarce.</p>`;
  }

  async function loadSlot(slot) {
    state.slot = slot;
    state.artist = '';
    savePrefs();
    let stored = null;
    try { stored = await loadData(slot); } catch { /* IndexedDB niedostępne */ }
    if (state.slot !== slot) return; // użytkownik zdążył przełączyć dalej
    state.exportRows = stored && stored.rows ? stored.rows : [];
    state.meta = stored ? stored.meta : null;
    document.getElementById('import-status').textContent = '';
    recombine();
    loadLiveFor(slot);
  }

  async function loadLiveFor(slot) {
    const L = window.SpotiLive;
    if (!L || !state.accounts || state.liveCache.has(slot)) return;
    const acc = accountOf(slot);
    if (!acc.files || !acc.files.length) return;
    try {
      const rows = A.normalizeRows(await L.loadRows(acc)).rows;
      state.liveCache.set(slot, rows);
      if (state.slot === slot) recombine();
    } catch { /* brak sieci — zostaje sam eksport */ }
  }

  async function loadAccounts() {
    const L = window.SpotiLive;
    if (!L || location.protocol === 'file:') return;
    try {
      state.accounts = await L.loadAccounts();
    } catch {
      state.accounts = null;
      return;
    }
    render();
    loadLiveFor(state.slot);
    try {
      state.images = await L.loadArtistImages();
      state.covers = await L.loadAlbumCovers().catch(() => new Map());
      await preloadImages([...state.images.values(), ...state.covers.values()], 300);
      if (state.imagesReady.size) render();
    } catch { /* bez zdjęć — zostają inicjały */ }
  }

  function renderLiveBanner() {
    const el = document.getElementById('live-banner');
    const L = window.SpotiLive;
    const s = state.accounts ? accountOf(state.slot) : null;
    let html = '';
    let warn = false;
    if (!s || (state.meta && state.meta.demo)) {
      html = '';
    } else if (!s.connectedAt) {
      html = 'Nowe odsłuchy mogą się dociągać same — <a href="./spotify.html">włącz automat</a>.';
    } else if (s.error === 'invalid_grant') {
      warn = true;
      html = `⚠️ Logowanie automatu do Spotify wygasło, więc nowe odsłuchy się nie dociągają. <a href="./spotify.html?konto=${state.slot}">Zaloguj się ponownie</a>.`;
    } else if (L.tokenAgeDays(s) > L.TOKEN_LIFETIME_DAYS - 14) {
      warn = true;
      html = `⚠️ Logowanie automatu do Spotify wygaśnie za ok. ${Math.max(0, Math.round(L.TOKEN_LIFETIME_DAYS - L.tokenAgeDays(s)))} dni. <a href="./spotify.html?konto=${state.slot}">Odnów je</a>.`;
    } else if (s.error) {
      warn = true;
      html = `⚠️ Ostatnia synchronizacja się nie udała. <a href="./spotify.html">Szczegóły</a>.`;
    } else if (s.lastSync) {
      const ago = Math.floor((Date.now() - Date.parse(s.lastSync)) / 3_600_000);
      warn = ago > 6;
      html = `${warn ? '⚠️' : '<span class="live-dot"></span>'} Automat: ostatnia synchronizacja ${ago < 1 ? 'mniej niż godzinę' : `${ago} godz.`} temu` +
        (state.liveAdded ? `, dołożył ${nf.format(state.liveAdded)} odsłuchów${state.exportRows.length ? ' po końcu eksportu' : ''}.` : '.') +
        (warn ? ' Coś się zacięło — <a href="./spotify.html">sprawdź</a>.' : '');
    }
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    el.classList.toggle('live-banner--warn', warn);
  }

  /** Podświetla w menu sekcję, którą akurat czytasz. */
  function wireScrollSpy() {
    if (!('IntersectionObserver' in window)) return;
    const links = [...document.querySelectorAll('.side-link[href^="#"], .bottom-nav a[href^="#"]')];
    const targets = [...new Set(links.map((l) => l.getAttribute('href').slice(1)))].map((id) => document.getElementById(id)).filter(Boolean);
    const visible = new Set();
    const mark = () => {
      const first = targets.find((t) => visible.has(t.id));
      links.forEach((l) => l.classList.toggle('is-active', Boolean(first) && l.getAttribute('href') === `#${first.id}`));
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) (e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id));
      mark();
    }, { rootMargin: '-25% 0px -60% 0px' });
    targets.forEach((t) => io.observe(t));
  }

  async function init() {
    loadPrefs();
    wire();
    wireScrollSpy();
    renderAccounts();
    await loadSlot(state.slot);
    loadAccounts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
