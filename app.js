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
  const PROFILE_KEY = 'ss_profile'; // zalogowane konto (wybór na ekranie „Kto słucha?”)
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
    artistSpan: 'range', // wykres wykonawcy domyślnie trzyma się wybranego okresu
    artistUnit: null,
    recordsKind: 'artist',
    taTab: 'tracks', // telefon: zakładka Top utwory / Top albumy
    saveWarning: '',
    importNote: '',
    cloudMsg: null, // { text, warn } — komunikat o zapisie na GitHubie
    cloudBusy: false,
    showMore: false, // topki: 10 pozycji albo 25
    topMode: 'ms', // Ranking w czasie: 'ms' = minuty, 'rank' = pozycja w rankingu
    compare: [], // dodatkowi wykonawcy na wykresie w karcie wykonawcy
    compareHidden: new Set(), // null = automatycznie (tygodnie do roku, dłużej miesiące)
    slot: 1,
    profile: null, // zalogowane konto; null = pokaż ekran wyboru
    accounts: null, // z konta.json (null = jeszcze nie wczytane / brak sieci)
    liveCache: new Map(), // slot -> znormalizowane wiersze z automatu
    images: new Map(), // nazwa wykonawcy małymi literami -> url zdjęcia (z automatu)
    covers: new Map(), // „wykonawca|album” małymi literami -> url okładki
    imagesReady: new Set() // adresy zdjęć już wczytanych (tylko te pokazujemy — bez migania)
  };

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      for (const k of ['range', 'year', 'sortBy', 'topKind', 'artist', 'slot', 'topMode']) if (p[k] != null) state[k] = p[k];
      const prof = Number(localStorage.getItem(PROFILE_KEY));
      state.profile = prof >= 1 && prof <= 5 ? prof : null;
      const q = Number(new URLSearchParams(location.search).get('konto'));
      if (q >= 1 && q <= 5) { state.profile = q; localStorage.setItem(PROFILE_KEY, String(q)); }
      if (state.profile) state.slot = state.profile;
    } catch { /* brak dostępu do localStorage — trudno */ }
  }
  function savePrefs() {
    try {
      const { range, year, sortBy, topKind, artist, artistSpan, slot, topMode } = state;
      localStorage.setItem(PREFS_KEY, JSON.stringify({ range, year, sortBy, topKind, artist, artistSpan, slot, topMode }));
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
      // Nowszy eksport dokłada się do wcześniejszych danych (bez dublowania) — nie trzeba trzymać starych plików.
      const prev = state.exportRows.length && !(state.meta && state.meta.demo) ? state.exportRows : null;
      const finalRows = prev ? A.mergeRows(prev, rows) : rows;
      const added = prev ? finalRows.length - prev.length : 0;
      if (prev && !added) {
        status.textContent = '';
        setCloudMsg('Ten eksport nie zawiera nic nowego — dotychczasowe dane zostały bez zmian.');
        return;
      }
      state.importNote = prev ? `Dołączono ${nf.format(added)} nowych odsłuchów do wcześniejszych (razem ${nf.format(finalRows.length)}).` : '';
      const meta = { ...report, errors, importedAt: Date.now(), ...(prev ? { merged: true, added } : {}) };
      setData(finalRows, meta);
      status.textContent = '';
      state.saveWarning = '';
      if (state.importNote) setCloudMsg(state.importNote);
      try {
        await saveData(state.slot, { rows: finalRows, meta });
        // Sprawdzamy, czy przeglądarka faktycznie zapamiętała dane (okienka innych aplikacji potrafią je gubić).
        const back = await loadData(state.slot);
        if (!back || !back.rows || back.rows.length !== finalRows.length) throw new Error('niezapisane');
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      } catch {
        state.saveWarning = 'Ta przeglądarka nie zapamiętała wgranego eksportu, więc po zamknięciu strony trzeba będzie go wgrać ponownie. Otwórz stronę w Safari/Chrome (nie z okienka innej aplikacji) i wgraj plik jeszcze raz.';
      }
      render();
      if (getToken() && !state.saveWarning) cloudSend();
    } catch (err) {
      status.classList.add('import-status--error');
      status.textContent = `Błąd: ${err.message}`;
    }
  }

  // ─────────────────────────────────────────────────────── ANIMACJE
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Podpis danych — animujemy wejście tylko gdy się zmienił (nie przy przerysowaniu po zdjęciach czy obrocie). */
  const dataSig = () => `${state.slot}|${state.range}|${state.year}|${state.sortBy}|${state.meta && state.meta.demo ? 'demo' : ''}`;
  function enter(el, sig) {
    if (!el || el.dataset.sig === sig) return;
    const first = el.dataset.sig == null;
    el.dataset.sig = sig;
    if (reduceMotion() || first && !state.rows.length) return;
    el.classList.remove('is-entering');
    void el.offsetWidth; // restart animacji
    el.classList.add('is-entering');
    // Zdjęcie się doczyta → lista przerysuje się — wtedy już bez ponownej animacji.
    clearTimeout(el._enterTimer);
    el._enterTimer = setTimeout(() => el.classList.remove('is-entering'), 900);
  }
  /** Liczby w kafelkach „dobiegają” do nowej wartości. */
  const kpiPrev = new Map();
  function countUp(root) {
    root.querySelectorAll('[data-count]').forEach((el) => {
      const to = Number(el.dataset.count);
      const key = el.dataset.key;
      const fromV = kpiPrev.has(key) ? kpiPrev.get(key) : to;
      kpiPrev.set(key, to);
      const suffix = el.dataset.suffix || '';
      if (fromV === to || reduceMotion()) { el.textContent = nf.format(to) + suffix; return; }
      const t0 = performance.now();
      const dur = 550;
      const step = (now) => {
        if (!el.isConnected) return;
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = nf.format(Math.round(fromV + (to - fromV) * e)) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
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
  // Ten sam zakres = ta sama tablica, więc obliczenia (topki, podsumowania) liczą się tylko raz.
  const sliceMemo = new Map();
  let sliceMemoRows = null;
  function sliceOf(rows, from, to) {
    if (rows !== state.rows) return A.sliceRange(rows, from, to);
    if (sliceMemoRows !== rows) { sliceMemo.clear(); sliceMemoRows = rows; }
    const k = `${from}|${to}`;
    let sl = sliceMemo.get(k);
    if (!sl) {
      sl = A.sliceRange(rows, from, to);
      if (sliceMemo.size > 12) sliceMemo.clear();
      sliceMemo.set(k, sl);
    }
    return sl;
  }

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
  /* Brakujące zdjęcia i okładki dociągane z publicznego API Deezera (tylko nazwy wykonawców/albumów). */
  const isDemo = () => !!(state.meta && state.meta.demo);
  let art = null;
  let renderTimer = 0;
  const warming = new Set();
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => render(), 400);
  }
  function warm(url) {
    if (warming.has(url)) return;
    warming.add(url);
    preloadImages([url], 1, 8000).then(() => { if (state.imagesReady.has(url)) scheduleRender(); });
  }
  try {
    if (window.SpotiArt) art = SpotiArt.createLoader({ storage: window.localStorage, onChange: scheduleRender });
  } catch { art = null; }

  /** Zdjęcie wykonawcy, jeśli automat je zdobył — inaczej kolorowe inicjały. */
  function artistAvatar(name, cls = '') {
    const img = state.images.get(String(name).toLowerCase()) || (art && !isDemo() ? art.artist(name) : null);
    if (!img || !state.imagesReady.has(img)) { if (img) warm(img); return avatar(name, cls); }
    return `<span class="avatar avatar--img ${cls}" style="--h:${hueOf(name)}" aria-hidden="true"><img src="${esc(img)}" alt="" decoding="sync" referrerpolicy="no-referrer" onerror="this.remove()" />${esc(initials(name))}</span>`;
  }
  /** Okładka albumu (utworu / albumu), jeśli automat ją zdobył — inaczej kolorowe inicjały. */
  function coverAvatar(title, artist, album, cls = '') {
    const img = album ? state.covers.get(`${String(artist).toLowerCase()}|${String(album).toLowerCase()}`) || (art && !isDemo() ? art.cover(artist, album) : null) : null;
    if (!img || !state.imagesReady.has(img)) { if (img) warm(img); return avatar(title, cls); }
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
    if (a.connectedAt || a.export) return slot === 1 ? 'Ty' : `Konto ${slot}`;
    return slot === 1 ? 'Ty' : null;
  }
  function slotHasData(slot) {
    return Boolean(accountOf(slot).connectedAt || accountOf(slot).export) || slot === state.slot && state.exportRows.length > 0;
  }

  /** Pasek boczny / nagłówek: tylko zalogowana osoba; klik = zmiana konta (ekran „Kto słucha?”). */
  function renderAccounts() {
    const list = document.getElementById('account-list');
    const slot = state.slot;
    const name = accountName(slot) || `Nowa osoba`;
    const a = accountOf(slot);
    const sub = a.connectedAt ? (a.error ? 'automat: błąd' : 'automat działa') : a.export ? 'eksport na GitHubie' : state.exportRows.length ? 'eksport w tej przeglądarce' : 'brak danych';
    list.innerHTML = `<li><button type="button" class="account is-active" data-logout title="Zmień konto / wyloguj">
        ${accountName(slot) ? avatar(name, 'avatar--sm') : '<span class="avatar avatar--sm avatar--empty" aria-hidden="true">+</span>'}
        <span class="account-text"><span class="account-name">${esc(name)}</span><span class="account-sub">${sub}</span></span>
        <span class="account-switch" aria-hidden="true">Zmień</span>
      </button></li>`;
  }

  // ─────────────────────────────────────────────────────── KTO SŁUCHA? (wybór konta)
  let localSlots = new Set();
  async function scanLocalSlots() {
    const found = new Set();
    await Promise.all([1, 2, 3, 4, 5].map(async (n) => {
      try { const d = await loadData(n); if (d && d.rows && d.rows.length && !(d.meta && d.meta.demo)) found.add(n); } catch { /* brak IndexedDB */ }
    }));
    localSlots = found;
  }
  function whoSlots() {
    return [1, 2, 3, 4, 5].filter((n) => accountName(n) || localSlots.has(n) || n === 1);
  }
  function renderWho() {
    const el = document.getElementById('who');
    if (!el || el.classList.contains('hidden')) return;
    const slots = whoSlots();
    const free = [1, 2, 3, 4, 5].find((n) => !slots.includes(n));
    const people = slots.map((n) => {
      const name = accountName(n) || (n === 1 ? 'Ty' : `Konto ${n}`);
      const a = accountOf(n);
      const sub = a.connectedAt ? 'automat działa' : a.export || localSlots.has(n) ? 'eksport' : 'brak danych';
      return `<li><button type="button" class="who-card" data-login="${n}">${avatar(name, 'avatar--who')}<span class="who-name">${esc(name)}</span><span class="who-sub">${sub}</span></button></li>`;
    });
    if (free) people.push(`<li><button type="button" class="who-card who-card--add" data-login="${free}"><span class="avatar avatar--who avatar--empty" aria-hidden="true">+</span><span class="who-name">Dodaj osobę</span><span class="who-sub">wolne miejsce ${free} z 5</span></button></li>`);
    document.getElementById('who-list').innerHTML = people.join('');
    document.getElementById('who-loading').classList.toggle('hidden', !state.booting);
  }
  function showWho() {
    closeMenu();
    if (sheetOpen()) closeSheet(true);
    document.getElementById('who').classList.remove('hidden');
    document.body.classList.add('who-open');
    window.scrollTo(0, 0);
    renderWho();
    scanLocalSlots().then(renderWho);
  }
  function login(slot) {
    state.profile = slot;
    try { localStorage.setItem(PROFILE_KEY, String(slot)); } catch { /* ignoruj */ }
    const who = document.getElementById('who');
    who.classList.add('is-leaving');
    setTimeout(() => { who.classList.add('hidden'); who.classList.remove('is-leaving'); document.body.classList.remove('who-open'); }, reduceMotion() ? 0 : 220);
    state.compare = [];
    setCloudMsg('');
    if (slot !== state.slot || !state.rows.length) loadSlot(slot); else render();
  }
  function logout() {
    state.profile = null;
    try { localStorage.removeItem(PROFILE_KEY); } catch { /* ignoruj */ }
    if (new URLSearchParams(location.search).has('konto')) history.replaceState(null, '', location.pathname);
    showWho();
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
    document.getElementById('year-select').innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    document.getElementById('artist-list').innerHTML = A.allArtists(rows).map((a) => `<option value="${esc(a)}"></option>`).join('');
    state.visibleFor = '';
    render();
  }

  function render() {
    const has = state.rows.length > 0;
    // Zanim dojdą dane z GitHuba, pokazujemy ładowanie — a nie ekran „wgraj plik”, który by tylko mignął.
    const loading = !has && (state.booting || state.cloudLoading === state.slot);
    document.getElementById('state-loading').classList.toggle('hidden', !loading);
    document.getElementById('loading-text').textContent = state.cloudLoading === state.slot ? 'Wczytuję eksport z GitHuba…' : 'Wczytuję Twoją historię…';
    document.getElementById('state-empty').classList.toggle('hidden', has || loading);
    document.getElementById('state-data').classList.toggle('hidden', !has);
    document.getElementById('topbar-actions').classList.toggle('hidden', !has);
    document.body.classList.toggle('has-data', has);
    renderAccounts();
    renderLiveBanner();
    renderCloud();
    // Bez danych nagłówek profilu tylko by powtarzał tytuł ekranu importu / ładowania.
    document.getElementById('hero').classList.toggle('hidden', !has);
    if (!has) { renderEmpty(); renderHero(null); return; }

    const m = state.meta || {};
    const parts = [`${nf.format(state.rows.length)} odsłuchów`];
    if (state.liveAdded) parts.push(`w tym ${nf.format(state.liveAdded)} z automatu`);
    if (m.podcasts) parts.push(`${nf.format(m.podcasts)} podcastów pominiętych`);
    if (m.duplicates) parts.push(`${nf.format(m.duplicates)} duplikatów usuniętych`);
    if (m.importedAt && !m.demo) {
      const onGh = state.accounts && accountOf(state.slot).export && accountOf(state.slot).export.importedAt === m.importedAt;
      parts.push(m.fromCloud ? `eksport z GitHuba (wgrany ${fmtDate(m.importedAt)})`
        : `eksport zapisany w tej przeglądarce (wgrany ${fmtDate(m.importedAt)})${onGh ? ' i na GitHubie' : ', jeszcze nie na GitHubie'}`);
    }
    document.getElementById('data-info').textContent = parts.join(' · ');
    document.getElementById('data-info').title = m.usedFiles ? `Wczytane pliki:\n${m.usedFiles.join('\n')}` : '';

    document.querySelectorAll('#range-pills .chip').forEach((p) => p.classList.toggle('is-active', p.dataset.range === state.range));
    document.getElementById('year-select').value = String(state.year);
    document.querySelectorAll('.sort-group button').forEach((p) => {
      p.classList.toggle('is-active', p.dataset.sort === state.sortBy);
      p.setAttribute('aria-pressed', String(p.dataset.sort === state.sortBy));
    });
    syncSeg('ta-tabs', 'tab', state.taTab);
    document.getElementById('sec-tracks').dataset.tab = state.taTab;

    const { from, to } = currentBounds();
    const slice = sliceOf(state.rows, from, to);
    const lastTs = state.rows[state.rows.length - 1].t;
    let label = fmtSpan(from, to);
    // Dopisek tylko, gdy dane są nieświeże (np. sam eksport sprzed tygodni) — inaczej to szum.
    if (state.range !== 'year' && state.range !== 'all' && Date.now() - lastTs > 2 * 86_400_000) label += ` · do ostatniego odsłuchu (${fmtDate(lastTs)})`;
    document.getElementById('range-label').textContent = label;

    const sum = A.summary(slice, from, to);
    renderHero(sum);
    renderKpis(sum);
    renderTops(slice);
    renderRecent();
    renderWhen(slice);
    renderRecords(slice, from, to);
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
    const kpi = (label, n, sub, suffix = '') => `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value" data-count="${n}" data-key="${label}" data-suffix="${suffix}">${nf.format(kpiPrev.has(label) ? kpiPrev.get(label) : n)}${suffix}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
    const row = document.getElementById('kpi-row');
    row.innerHTML = [
      kpi('Minuty', minutes(s.ms), `${nf.format(Math.round(s.ms / 3_600_000))} godz.`),
      kpi('Odtworzenia', s.plays, 'co najmniej 30 s'),
      kpi('Wykonawcy', s.artists),
      kpi('Utwory', s.tracks),
      kpi('Albumy', s.albums),
      kpi('Na dzień', Math.round(s.minutesPerDay), '', ' min')
    ].join('');
    countUp(row);
  }

  const valueOf = (it) => (state.sortBy === 'plays' ? `${nf.format(it.plays)} odtw.` : `${nf.format(minutes(it.ms))} min`);

  /** Pozycje z poprzedniego, równie długiego okresu (do strzałek ▲▼). Dla „cały czas” brak porównania. */
  function previousRanks(kind) {
    if (state.range === 'all') return null;
    const { from, to } = currentBounds();
    const prev = sliceOf(state.rows, from - (to - from), from);
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
    const sig = `${dataSig()}|${state.showMore}`;
    ['top-artists', 'top-tracks', 'top-albums'].forEach((id) => enter(document.getElementById(id), sig));
  }

  // ─────────────────────────────────────────────────────── REKORDY
  const plWeeks = (n) => `${nf.format(n)} ${n === 1 ? 'tydzień' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'tygodnie' : 'tygodni'}`;
  const fmtWeek = (ms) => `tydzień od ${fmtDate(ms)}`;
  let recordsCache = { rows: null, from: null, to: null, sortBy: null, data: {} };
  function recordsFor(kind, slice, from, to) {
    const c = recordsCache;
    if (c.rows !== state.rows || c.from !== from || c.to !== to || c.sortBy !== state.sortBy) recordsCache = { rows: state.rows, from, to, sortBy: state.sortBy, data: {} };
    return (recordsCache.data[kind] ||= A.records(slice, kind, { limit: 5, sortBy: state.sortBy }));
  }
  let lastRecordsArgs = null;
  function renderRecords(slice, from, to) {
    if (slice) lastRecordsArgs = [slice, from, to]; else if (lastRecordsArgs) [slice, from, to] = lastRecordsArgs; else return;
    document.querySelectorAll('#records-kind button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.kind === state.recordsKind);
      b.setAttribute('aria-pressed', String(b.dataset.kind === state.recordsKind));
    });
    const kind = state.recordsKind;
    const r = recordsFor(kind, slice, from, to);
    const el = document.getElementById('records-body');
    if (!r.totalWeeks) { el.innerHTML = '<p class="no-data">Brak odsłuchów.</p>'; return; }
    const av = (it, cls) => (kind === 'artist' ? artistAvatar(it.name, cls) : coverAvatar(`${it.name} ${it.artist}`, it.artist, it.album, cls));
    const sub = (it) => (kind === 'track' ? `<span class="track-sub">${esc(it.artist)}</span>` : '');
    const noun = kind === 'artist' ? 'wykonawca' : 'utwór';
    const hero = r.longest;
    const now = r.current;
    const lastWeek = A.bucketStart(Math.min(to - 1, state.rows[state.rows.length - 1].t), 'week');
    const nowLabel = now && now.week === lastWeek ? `Nr 1 w tym tygodniu` : 'Ostatni nr 1';
    const nowSub = now ? `${now.run > 1 ? `${plWeeks(now.run)} z rzędu · ` : ''}${state.sortBy === 'plays' ? `${nf.format(now.plays)} odtw.` : `${nf.format(minutes(now.ms))} min`} w tygodniu od ${fmtDate(now.week)}` : '';
    const leaders = r.leaders.map((l, i) => `<li class="rec-row" data-artist="${esc(l.artist)}" tabindex="0" role="button">
        <span class="track-rank">${i + 1}</span>
        <span class="track-text"><span class="track-name">${esc(l.name)}</span>${sub(l)}</span>
        <span class="rec-val"><b>${plWeeks(l.weeks)}</b><small>najdłużej z rzędu: ${l.longest}</small></span></li>`).join('');
    const peaks = r.peaks.map((p, i) => `<li class="rec-row" data-artist="${esc(p.artist)}" tabindex="0" role="button">
        <span class="track-rank">${i + 1}</span>
        <span class="track-text"><span class="track-name">${esc(p.name)}</span><span class="track-sub">${kind === 'track' ? `${esc(p.artist)} · ` : ''}${fmtWeek(p.week)}</span></span>
        <span class="rec-val"><b>${state.sortBy === 'plays' ? `${nf.format(p.plays)} odtw.` : `${nf.format(minutes(p.ms))} min`}</b><small>${state.sortBy === 'plays' ? `${nf.format(minutes(p.ms))} min` : `${nf.format(p.plays)} odtw.`}</small></span></li>`).join('');
    el.innerHTML = `
      <div class="rec-heroes">
      ${now ? `<button type="button" class="rec-hero rec-hero--now" data-artist="${esc(now.artist)}">
        <span class="rec-hero__label"><svg class="ico ico--sm" aria-hidden="true"><use href="#i-crown"/></svg> ${nowLabel}</span>
        <span class="rec-hero__main">${av(now, 'avatar--lg')}<span><span class="rec-hero__name">${esc(now.name)}</span>
          ${kind === 'track' ? `<span class="rec-hero__sub">${esc(now.artist)}</span>` : ''}
          <span class="rec-hero__sub">${nowSub}</span></span></span>
      </button>` : ''}
      <button type="button" class="rec-hero" data-artist="${esc(hero.artist)}">
        <span class="rec-hero__label"><svg class="ico ico--sm" aria-hidden="true"><use href="#i-trophy"/></svg> Najdłuższa seria na nr 1 (${noun})</span>
        <span class="rec-hero__main">${av(hero, 'avatar--lg')}<span><span class="rec-hero__name">${esc(hero.name)}</span>
          <span class="rec-hero__val">${plWeeks(hero.weeks)} z rzędu</span>
          <span class="rec-hero__sub">od ${fmtDate(hero.from)}</span></span></span>
      </button>
      </div>
      <div class="rec-col"><h3 class="sub-title">Najwięcej tygodni na nr 1</h3><ol class="rec-list">${leaders}</ol></div>
      <div class="rec-col"><h3 class="sub-title">Największe tygodnie</h3><ol class="rec-list">${peaks}</ol></div>`;
    enter(el, `${dataSig()}|${kind}`);
  }

  // ─────────────────────────────────────────────────────── KIEDY SŁUCHASZ
  const DAY_NAMES = ['Pon', 'Wt', 'Śr', 'Czw', 'Pt', 'Sob', 'Nd'];
  const DAY_FULL = ['w poniedziałki', 'we wtorki', 'w środy', 'w czwartki', 'w piątki', 'w soboty', 'w niedziele'];
  let whenData = null;
  function bars(values, labels, peak, labelEvery = 1, fmt) {
    const max = Math.max(1, ...values);
    return values.map((v, i) => `<div class="bar${i === peak ? ' is-peak' : ''}" data-i="${i}" aria-label="${esc(fmt(i, v))}" style="--d:${i * 14}ms">
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
    const share = (v, all) => (all ? ` · ${Math.round((v / all) * 100)}%` : '');
    const totalH = r.hours.reduce((a, b) => a + b, 0);
    document.getElementById('when-hours-out').innerHTML = r.total ? `Szczyt: <b>${hh(r.peakHour)}</b> · ${nf.format(minutes(r.hours[r.peakHour]))} min${share(r.hours[r.peakHour], totalH)}` : '';
    document.getElementById('when-days-out').innerHTML = r.total ? `Szczyt: <b>${DAY_NAMES[r.peakDay]}</b> · ${nf.format(minutes(r.days[r.peakDay]))} min${share(r.days[r.peakDay], totalH)}` : '';
    whenData = { r, hh, totalH, share };
    enter(document.getElementById('sec-when'), dataSig());
  }

  // ─────────────────────────────────────────────────────── OSTATNIO SŁUCHANE
  function agoLabel(ms) {
    const min = Math.floor((Date.now() - ms) / 60_000);
    if (min < 1) return 'przed chwilą';
    if (min < 60) return `${min} min temu`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} godz. temu`;
    const d = new Date(ms);
    const days = Math.floor(h / 24);
    if (days === 1) return `wczoraj ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (days < 7) return `${days} dni temu`;
    return fmtDate(ms);
  }
  function renderRecent() {
    const el = document.getElementById('recent-list');
    const out = [];
    for (let i = state.rows.length - 1; i >= 0 && out.length < 10; i--) if (state.rows[i].ms >= 30_000) out.push(state.rows[i]);
    el.innerHTML = out.length ? `<ol class="tracklist">${out.map((r) => `<li class="track-row track-row--recent" data-artist="${esc(r.artist)}" tabindex="0" role="button" title="Pokaż wykres: ${esc(r.artist)}">
        ${coverAvatar(`${r.track} ${r.artist}`, r.artist, r.album, 'avatar--cover')}
        <span class="track-text"><span class="track-name">${esc(r.track)}</span><span class="track-sub">${esc(r.artist)}</span></span>
        <span class="track-val track-val--when">${agoLabel(r.t)}</span></li>`).join('')}</ol>` : '<p class="no-data">Brak odsłuchów.</p>';
    enter(el, `${state.slot}|${out.length ? out[0].t : 0}`);
  }

  // ─────────────────────────────────────────────────────── LEGENDY (wspólne)
  /** Legenda z przyciskami: klik włącza/wyłącza serię, najechanie podświetla ją na wykresie. */
  function legendHtml(items, { removable = false } = {}) {
    return items.map((it) => `<button type="button" class="legend-item${it.on ? '' : ' is-off'}" data-name="${esc(it.name)}" aria-pressed="${it.on}" title="${it.on ? 'Ukryj' : 'Pokaż'} na wykresie">
      <span class="swatch" style="${it.on ? `background:${it.color}` : ''}"></span>${it.rank ? `<span class="legend-rank">${it.rank}.</span> ` : ''}${esc(it.label || it.name)}${removable && it.removable ? '<span class="legend-x" data-remove title="Usuń z porównania" aria-label="Usuń">×</span>' : ''}</button>`).join('');
  }
  function wireLegendHighlight(legendId, chartId) {
    const legend = document.getElementById(legendId);
    const chart = () => document.getElementById(chartId)._chart;
    const on = (e) => {
      const b = e.target.closest('.legend-item:not(.is-off)');
      const c = chart();
      if (c) c.highlight(b ? b.dataset.name : null);
    };
    legend.addEventListener('pointerover', (e) => { if (e.pointerType !== 'touch') on(e); });
    legend.addEventListener('focusin', on);
    legend.addEventListener('pointerleave', () => { const c = chart(); if (c) c.highlight(null); });
    legend.addEventListener('focusout', () => { const c = chart(); if (c) c.highlight(null); });
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
    // Pozycje tydzień po tygodniu przez pół roku i dłużej to „spaghetti” — domyślnie miesiące.
    const unit = pickUnit(state.topUnit || (state.topMode === 'rank' && (to - from) / 86_400_000 > 120 ? 'month' : null), from, to);
    syncSeg('top-kind', 'kind', kind);
    syncSeg('top-unit', 'unit', unit, allowedUnits(from, to));

    const items = A.top(slice, kind, { sortBy: state.sortBy, limit: 10 });
    ensureVisible(items, `${kind}|${state.range}|${state.year}|${state.sortBy}`);

    const legend = document.getElementById('top-legend');
    legend.innerHTML = items.map((it, i) => {
      const color = state.visible.get(it.key);
      const name = kind === 'track' ? `${it.name} — ${it.artist}` : it.name;
      return `<button type="button" class="legend-item${color ? '' : ' is-off'}" data-key="${esc(it.key)}" data-name="${esc(name)}" aria-pressed="${Boolean(color)}" title="${color ? 'Ukryj' : 'Pokaż'} na wykresie">
        <span class="swatch" style="${color ? `background:${color}` : ''}"></span><span class="legend-rank">${i + 1}.</span> ${esc(name)}</button>`;
    }).join('');

    const shown = items.filter((it) => state.visible.has(it.key));
    const label = (it) => (kind === 'track' ? `${it.name} — ${it.artist}` : it.name);
    const mode = state.topMode;
    syncSeg('top-mode', 'mode', mode);
    const DEPTH = 10;
    document.getElementById('top-hint').textContent = mode === 'rank'
      ? `Miejsce w rankingu w każdym okresie (#1 na górze, „dalej” = poza top ${DEPTH}). Kliknij nazwę, żeby ją pokazać lub ukryć, najedź, żeby wyróżnić.`
      : 'Minuty słuchania w każdym okresie. Kliknij nazwę, żeby ją pokazać lub ukryć (max 8 naraz), najedź, żeby wyróżnić.';
    if (mode === 'rank') {
      const rk = A.rankSeries(slice, from, to, unit, kind, shown.map((it) => it.key), { depth: DEPTH, sortBy: state.sortBy });
      C.lineChart(document.getElementById('top-chart'), {
        buckets: rk.buckets,
        unit,
        rank: true,
        rankOut: true,
        maxRank: DEPTH + 1,
        height: 320,
        series: shown.map((it, i) => ({ name: label(it), color: state.visible.get(it.key), values: rk.series[i].values })),
        tipExtra: (i) => {
          const l = rk.leaders[i];
          if (!l) return '';
          const v = state.sortBy === 'plays' ? `${nf.format(l.plays)} odtw.` : `${nf.format(minutes(l.ms))} min`;
          return `<div class="chart-tip__lead">👑 ${esc(kind === 'track' ? `${l.name} — ${l.artist}` : l.name)} · ${v}</div>`;
        }
      });
    } else {
      const keyOf = kind === 'track' ? A.trackKey : (r) => r.artist;
      const tl = A.timeline(slice, from, to, unit, shown.map((it) => ({ key: it.key, match: (r) => keyOf(r) === it.key })));
      C.lineChart(document.getElementById('top-chart'), {
        buckets: tl.buckets,
        unit,
        series: shown.map((it, i) => ({ name: label(it), color: state.visible.get(it.key), values: tl.series[i].values }))
      });
    }
    if (!items.length) document.getElementById('top-chart').innerHTML = '<p class="no-data">Brak odsłuchów w tym zakresie.</p>';
    else if (!shown.length) document.getElementById('top-chart').innerHTML = '<p class="no-data">Zaznacz kogoś w legendzie.</p>';
  }

  function renderArtist(rangeFrom, rangeTo) {
    const body = document.getElementById('artist-body');
    const input = document.getElementById('artist-search');
    if (document.activeElement !== input) input.value = state.artist;
    syncSeg('artist-span', 'span', state.artistSpan);

    if (!state.artist) {
      const first = A.top(sliceOf(state.rows, rangeFrom, rangeTo), 'artist', { limit: 1 })[0];
      if (first) state.artist = first.name;
      input.value = state.artist;
    }
    const details = A.artistDetails(state.rows, state.artist);
    const top = document.getElementById('artist-top');
    if (!details.first) {
      top.innerHTML = '';
      syncSeg('artist-unit', 'unit', '', { day: false, week: false, month: false });
      body.innerHTML = state.artist
        ? `<p class="no-data">Nie ma „${esc(state.artist)}” w Twojej historii. Wybierz z podpowiedzi.</p>`
        : '<p class="no-data">Wpisz wykonawcę albo kliknij go w topce.</p>';
      return;
    }

    // Porównanie: główny wykonawca + do 4 innych (bez duplikatów i bez nieistniejących).
    state.compare = state.compare.filter((n) => n !== state.artist);
    const compared = state.compare.map((n) => ({ name: n, d: A.artistDetails(state.rows, n) })).filter((c) => c.d.first);
    let from, to;
    if (state.artistSpan === 'range') ({ from, to } = { from: rangeFrom, to: rangeTo });
    else {
      from = A.bucketStart(Math.min(details.first, ...compared.map((c) => c.d.first)), 'day');
      to = A.bucketStart(state.rows[state.rows.length - 1].t, 'day') + 86_400_000;
    }
    const unit = pickUnit(state.artistUnit || 'week', from, to);
    syncSeg('artist-unit', 'unit', unit, allowedUnits(from, to));

    const inRange = sliceOf(state.rows, rangeFrom, rangeTo).filter((r) => r.artist === state.artist);
    const rangeStats = A.summary(inRange, rangeFrom, rangeTo);
    const tops = A.top(inRange, 'track', { sortBy: state.sortBy, limit: 10 });

    top.innerHTML = `
      <div class="artist-head">
        <div class="artist-id">${artistAvatar(details.artist, 'avatar--lg')}<h3 class="artist-name">${esc(details.artist)}</h3></div>
        <dl class="artist-facts">
          <div><dt>Łącznie</dt><dd>${nf.format(minutes(details.ms))} min · ${nf.format(details.plays)}×</dd></div>
          <div><dt>W wybranym zakresie</dt><dd>${nf.format(minutes(rangeStats.ms))} min · ${nf.format(rangeStats.plays)}×</dd></div>
          <div><dt>Pierwszy odsłuch</dt><dd>${fmtDate(details.first)}</dd></div>
          <div><dt>Ostatni odsłuch</dt><dd>${fmtDate(details.last)}</dd></div>
        </dl>
      </div>`;
    // Stała struktura (wykres nie jest tworzony od nowa — dzięki temu animuje się tylko przy zmianie danych).
    if (!document.getElementById('artist-chart')) {
      body.innerHTML = `
        <div id="artist-compare" class="compare"></div>
        <div id="artist-chart"></div>
        <h4 class="sub-title">Najczęściej słuchane utwory (wybrany zakres)</h4>
        <div id="artist-tracks"></div>`;
    }
    document.getElementById('artist-tracks').innerHTML = trackList(tops, 'track');
    enter(document.getElementById('artist-tracks'), `${state.artist}|${dataSig()}`);

    const palette = [SPOTIFY_GREEN, ...SERIES_COLORS.filter((c) => c !== '#0aac23')];
    const all = [{ name: state.artist, color: palette[0], main: true }, ...compared.map((c, i) => ({ name: c.name, color: palette[i + 1] }))];
    const quick = A.top(sliceOf(state.rows, rangeFrom, rangeTo), 'artist', { sortBy: state.sortBy, limit: 8 })
      .map((it) => it.name).filter((n) => !all.some((a) => a.name === n)).slice(0, 3);
    const canAdd = compared.length < 4;
    document.getElementById('artist-compare').innerHTML = `
      ${compared.length ? `<div class="legend" aria-label="Legenda — kliknij, by pokazać lub ukryć">${legendHtml(all.map((a) => ({ ...a, on: !state.compareHidden.has(a.name), removable: !a.main })), { removable: true })}</div>` : ''}
      ${canAdd ? `<div class="compare-add"><span class="compare-label">Porównaj z</span>
        ${quick.map((n) => `<button type="button" class="chip chip--sm" data-add="${esc(n)}">+ ${esc(n)}</button>`).join('')}
        <div class="combo combo--sm"><input id="compare-input" class="field-input field-input--sm" data-combo="compare" placeholder="inny wykonawca…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-label="Dodaj wykonawcę do porównania" /></div></div>` : ''}`;

    const shown = all.filter((a) => !state.compareHidden.has(a.name));
    const names = new Set(shown.map((a) => a.name));
    const own = state.rows.filter((r) => names.has(r.artist));
    const tl = A.timeline(own, from, to, unit, shown.map((a) => ({ key: a.name, match: (r) => r.artist === a.name })));
    const chartEl = document.getElementById('artist-chart');
    if (!shown.length) { chartEl.innerHTML = '<p class="no-data">Włącz kogoś w legendzie.</p>'; chartEl._chartPrev = null; return; }
    C.lineChart(chartEl, {
      buckets: tl.buckets,
      unit,
      area: true,
      series: shown.map((a, i) => ({ name: a.name, color: a.color, values: tl.series[i].values }))
    });
  }

  function selectArtist(name, open) {
    if (open && name !== state.artist) { state.compare = []; state.compareHidden.clear(); }
    state.artist = name;
    savePrefs();
    if (open) openSheet();
    const { from, to } = currentBounds();
    renderArtist(from, to);
    document.getElementById('sheet-title').textContent = state.artist;
  }

  // ─────────────────────────────────────────────────────── INTERAKCJE: legendy, porównanie, słupki
  /** Przeliczenie z krótkim przygaszeniem treści — zmiana okresu/sortowania wygląda płynnie, nie „skacze”. */
  function switchRender() {
    const box = document.getElementById('state-data');
    if (reduceMotion()) { render(); return; }
    box.classList.add('is-switching');
    requestAnimationFrame(() => setTimeout(() => {
      render();
      requestAnimationFrame(() => box.classList.remove('is-switching'));
    }, 60));
  }
  function rerenderArtist() {
    const { from, to } = currentBounds();
    renderArtist(from, to);
  }
  function addCompare(raw) {
    const v = String(raw || '').trim();
    if (!v) return;
    const match = A.allArtists(state.rows).find((a) => a.toLowerCase() === v.toLowerCase());
    if (!match || match === state.artist || state.compare.includes(match) || state.compare.length >= 4) return;
    state.compare.push(match);
    state.compareHidden.delete(match);
    rerenderArtist();
  }
  function wireInteractive() {
    wireLegendHighlight('top-legend', 'top-chart');
    wireLegendHighlight('artist-body', 'artist-chart');

    const body = document.getElementById('artist-body');
    body.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) { addCompare(add.dataset.add); return; }
      const b = e.target.closest('.legend-item');
      if (!b) return;
      const name = b.dataset.name;
      if (e.target.closest('[data-remove]')) {
        state.compare = state.compare.filter((n) => n !== name);
        state.compareHidden.delete(name);
      } else if (state.compareHidden.has(name)) state.compareHidden.delete(name);
      else state.compareHidden.add(name);
      rerenderArtist();
    });

    // Słupki „Kiedy słuchasz”: najechanie / dotknięcie pokazuje wartość pod wykresem.
    const pick = (box, out, kind) => (e) => {
      const bar = e.target.closest('.bar');
      if (!bar || !whenData) return;
      const i = Number(bar.dataset.i);
      const { r, hh, totalH, share } = whenData;
      box.querySelectorAll('.bar.is-sel').forEach((b) => b.classList.remove('is-sel'));
      bar.classList.add('is-sel');
      const v = kind === 'h' ? r.hours[i] : r.days[i];
      const label = kind === 'h' ? hh(i) : DAY_NAMES[i];
      out.innerHTML = `<b>${label}</b> · ${nf.format(minutes(v))} min${share(v, totalH)}`;
    };
    for (const [id, kind] of [['when-hours', 'h'], ['when-days', 'd']]) {
      const box = document.getElementById(id);
      const out = document.getElementById(`${id}-out`);
      box.addEventListener('pointerover', pick(box, out, kind));
      box.addEventListener('click', pick(box, out, kind));
    }
  }

  // ─────────────────────────────────────────────────────── WYBÓR WYKONAWCY (rozwijana lista z wyszukiwaniem)
  const fold = (t) => String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l');
  const combo = { input: null, list: null, items: [], active: -1 };
  function comboMatches(q) {
    const all = A.top(state.rows, 'artist', { sortBy: 'ms', limit: 0 }); // wg łącznego czasu słuchania
    const skip = combo.input && combo.input.dataset.combo === 'compare' ? new Set([state.artist, ...state.compare]) : new Set();
    const f = fold(q.trim());
    if (!f) return all.filter((a) => !skip.has(a.name)).slice(0, 40);
    const starts = [], words = [], inside = [];
    for (const a of all) {
      if (skip.has(a.name)) continue;
      const n = fold(a.name);
      if (n.startsWith(f)) starts.push(a);
      else if (n.split(/[\s\-&,.]+/).some((w) => w.startsWith(f))) words.push(a);
      else if (n.includes(f)) inside.push(a);
      if (starts.length >= 40) break;
    }
    return starts.concat(words, inside).slice(0, 40);
  }
  function comboRender() {
    if (!combo.input) return;
    const q = combo.input.dataset.touched ? combo.input.value : '';
    combo.items = comboMatches(q);
    if (combo.active >= combo.items.length) combo.active = combo.items.length - 1;
    combo.list.innerHTML = combo.items.length
      ? combo.items.map((a, i) => `<li role="option" class="combo-opt${i === combo.active ? ' is-active' : ''}${a.name === state.artist && combo.input.dataset.combo === 'artist' ? ' is-current' : ''}" data-i="${i}" aria-selected="${i === combo.active}">
          ${artistAvatar(a.name, 'avatar--xs')}<span class="combo-name">${esc(a.name)}</span><span class="combo-val">${nf.format(minutes(a.ms))} min</span></li>`).join('')
      : '<li class="combo-empty">Brak takiego wykonawcy w Twojej historii</li>';
    const act = combo.list.querySelector('.is-active');
    if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function comboOpen(input) {
    if (combo.input === input) return;
    comboClose();
    combo.input = input;
    combo.active = -1;
    delete input.dataset.touched;
    combo.list = document.createElement('ul');
    combo.list.className = 'combo-list';
    combo.list.setAttribute('role', 'listbox');
    // pointerdown zamiast click — żeby wybór zdążył przed utratą fokusu
    combo.list.addEventListener('pointerdown', (e) => {
      const li = e.target.closest('[data-i]');
      if (!li) return;
      e.preventDefault();
      comboPick(combo.items[Number(li.dataset.i)]);
    });
    input.closest('.combo').appendChild(combo.list);
    input.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => input.select());
    comboRender();
  }
  function comboClose() {
    if (!combo.input) return;
    combo.input.setAttribute('aria-expanded', 'false');
    if (combo.input.dataset.combo === 'artist') combo.input.value = state.artist;
    if (combo.list) combo.list.remove();
    combo.input = null;
    combo.list = null;
  }
  function comboPick(item) {
    if (!item || !combo.input) return;
    const kind = combo.input.dataset.combo;
    const input = combo.input;
    comboClose();
    input.blur();
    if (kind === 'compare') addCompare(item.name);
    else { selectArtist(item.name, false); document.getElementById('sheet-title').textContent = item.name; }
  }
  function wireCombo() {
    document.addEventListener('focusin', (e) => { if (e.target.matches('input[data-combo]')) comboOpen(e.target); });
    document.addEventListener('focusout', (e) => { if (e.target === combo.input) setTimeout(() => { if (combo.input && document.activeElement !== combo.input) comboClose(); }, 120); });
    document.addEventListener('pointerdown', (e) => { if (combo.input && !e.target.closest('.combo')) comboClose(); });
    document.addEventListener('input', (e) => {
      if (e.target !== combo.input) return;
      combo.input.dataset.touched = '1';
      combo.active = combo.input.value.trim() ? 0 : -1;
      comboRender();
    });
    document.addEventListener('keydown', (e) => {
      if (!combo.input || e.target !== combo.input) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = combo.items.length;
        if (!n) return;
        combo.active = e.key === 'ArrowDown' ? (combo.active + 1) % n : (combo.active - 1 + n) % n;
        comboRender();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        comboPick(combo.items[Math.max(0, combo.active)]);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        const input = combo.input;
        comboClose();
        input.blur();
      }
    });
    // Klik w strzałkę otwiera listę
    document.addEventListener('click', (e) => {
      const caret = e.target.closest('.combo-caret');
      if (caret) caret.closest('.combo').querySelector('input').focus();
    });
  }

  // ─────────────────────────────────────────────────────── MENU „⋯”
  function closeMenu() {
    const menu = document.getElementById('hero-menu');
    if (menu.classList.contains('hidden')) return;
    menu.classList.add('hidden');
    document.getElementById('btn-menu').setAttribute('aria-expanded', 'false');
  }
  function wireMenu() {
    const btn = document.getElementById('btn-menu');
    const menu = document.getElementById('hero-menu');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      btn.setAttribute('aria-expanded', String(open));
      if (open) { const first = menu.querySelector('.menu-item:not(.hidden)'); if (first) first.focus({ preventScroll: true }); }
    });
    menu.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('label.menu-item')) { e.preventDefault(); document.getElementById('reimport-files').click(); }
    });
    document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target !== btn) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!menu.classList.contains('hidden')) { closeMenu(); btn.focus(); } else if (sheetOpen()) closeSheet(); } });
  }

  // ─────────────────────────────────────────────────────── KARTA WYKONAWCY NA WIERZCHU
  // Klik w wykonawcę otwiera jego kartę nad stroną (zamiast przewijać na sam dół).
  // Ta sama sekcja #artist-card jest przenoszona do okna i z powrotem — jedna logika, jedne przyciski.
  let sheetHome = null;
  let sheetPushed = false;
  let sheetReturnFocus = null;
  const sheetOpen = () => !document.getElementById('artist-sheet').classList.contains('hidden');
  function openSheet() {
    const sheet = document.getElementById('artist-sheet');
    const card = document.getElementById('artist-card');
    if (sheetOpen()) { document.getElementById('sheet-slot').scrollTop = 0; return; }
    sheetReturnFocus = document.activeElement;
    if (!sheetHome) { sheetHome = document.createElement('div'); sheetHome.id = 'artist-card-home'; card.before(sheetHome); }
    document.getElementById('sheet-slot').appendChild(card);
    sheet.classList.remove('hidden');
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => sheet.classList.add('is-open'));
    document.getElementById('sheet-slot').scrollTop = 0;
    try { history.pushState({ sheet: true }, ''); sheetPushed = true; } catch { sheetPushed = false; }
    sheet.querySelector('.sheet__bar .icon-btn').focus({ preventScroll: true });
  }
  function closeSheet(fromHistory) {
    if (!sheetOpen()) return;
    const sheet = document.getElementById('artist-sheet');
    if (!fromHistory && sheetPushed) { sheetPushed = false; history.back(); return; } // popstate zamknie
    sheetPushed = false;
    sheet.classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    const done = () => {
      sheet.classList.add('hidden');
      if (sheetHome) sheetHome.replaceWith(document.getElementById('artist-card'));
      sheetHome = null;
      if (state.rows.length) { const { from, to } = currentBounds(); renderArtist(from, to); }
      if (sheetReturnFocus && document.contains(sheetReturnFocus)) sheetReturnFocus.focus({ preventScroll: true });
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setTimeout(done, 220);
  }
  function wireSheet() {
    document.getElementById('artist-sheet').addEventListener('click', (e) => {
      if (e.target.closest('[data-sheet-close]')) closeSheet();
    });
    window.addEventListener('popstate', () => { if (sheetOpen()) closeSheet(true); });
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

    document.getElementById('reimport-files').addEventListener('change', (e) => { closeMenu(); handleImport(e.target.files); e.target.value = ''; });

    document.getElementById('btn-clear-data').addEventListener('click', async () => {
      closeMenu();
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
      if (!pill || pill.dataset.range === state.range) return;
      state.range = pill.dataset.range;
      savePrefs();
      // Najpierw podświetl wybrany okres (natychmiastowa reakcja), potem przelicz resztę.
      document.querySelectorAll('#range-pills .chip').forEach((p) => p.classList.toggle('is-active', p.dataset.range === state.range));
      switchRender();
    });
    const yearSelect = document.getElementById('year-select');
    yearSelect.addEventListener('change', () => { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); switchRender(); });
    yearSelect.addEventListener('click', () => { if (state.range !== 'year') { state.range = 'year'; state.year = Number(yearSelect.value); savePrefs(); switchRender(); } });

    document.querySelectorAll('.sort-group').forEach((g) => g.addEventListener('click', (e) => {
      const pill = e.target.closest('button[data-sort]');
      if (!pill || pill.dataset.sort === state.sortBy) return;
      state.sortBy = pill.dataset.sort;
      savePrefs();
      document.querySelectorAll('.sort-group button').forEach((p) => p.classList.toggle('is-active', p.dataset.sort === state.sortBy));
      switchRender();
    }));
    document.getElementById('ta-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      state.taTab = b.dataset.tab;
      syncSeg('ta-tabs', 'tab', state.taTab);
      document.getElementById('sec-tracks').dataset.tab = state.taTab;
    });

    document.getElementById('top-kind').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.topKind = b.dataset.kind;
      savePrefs();
      render();
    });
    document.getElementById('top-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b || b.dataset.mode === state.topMode) return;
      state.topMode = b.dataset.mode;
      savePrefs();
      const { from, to } = currentBounds();
      renderTopChart(sliceOf(state.rows, from, to), from, to);
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
      renderTopChart(sliceOf(state.rows, from, to), from, to);
    });

    const onArtistPick = (e) => {
      const el = e.target.closest('[data-artist]');
      if (el) selectArtist(el.dataset.artist, true);
    };
    for (const id of ['top-artists', 'top-tracks', 'top-albums', 'recent-list']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('click', onArtistPick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') onArtistPick(e); });
    }

    document.getElementById('state-data').addEventListener('click', (e) => {
      if (!e.target.closest('[data-more]')) return;
      state.showMore = !state.showMore;
      const { from, to } = currentBounds();
      renderTops(sliceOf(state.rows, from, to));
    });

    document.getElementById('records-kind').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.recordsKind = b.dataset.kind;
      renderRecords();
    });
    document.getElementById('records-body').addEventListener('click', (e) => {
      const el = e.target.closest('[data-artist]');
      if (el) selectArtist(el.dataset.artist, true);
    });


    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-logout]')) { logout(); return; }
      const b = e.target.closest('[data-login]');
      if (b) login(Number(b.dataset.login));
    });

    document.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-copy]');
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Skopiowano ✓'; } catch { /* ignoruj */ }
    });

    wireCombo();

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

    // Przerysowanie tylko przy zmianie szerokości. Na telefonie chowanie paska adresu przy przewijaniu
    // zmienia wysokość okna — przeliczanie wtedy całej strony powodowało szarpanie.
    let resizeTimer;
    let lastWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.rows.length) render(); }, 150);
    });

    document.getElementById('live-banner').addEventListener('click', (e) => {
      if (e.target.closest('[data-dismiss-msg]')) setCloudMsg('');
    });
    wireMenu();
    wireSheet();
    wireInteractive();
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
      : free ? `Nowa osoba (miejsce ${slot})` : `Wczytaj eksport: ${accountName(slot)}`;
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
    maybeLoadCloudExport(slot);
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
      state.booting = false;
      render();
      renderWho();
      return;
    }
    state.booting = false;
    maybeLoadCloudExport(state.slot);
    render();
    renderWho();
    loadLiveFor(state.slot);
    try {
      state.images = await L.loadArtistImages();
      state.covers = await L.loadAlbumCovers().catch(() => new Map());
      await preloadImages([...state.images.values(), ...state.covers.values()], 300);
      if (state.imagesReady.size) render();
    } catch { /* bez zdjęć — zostają inicjały */ }
  }

  const WARN_ICO = '<svg class="ico ico--sm" aria-hidden="true"><use href="#i-warn"/></svg>';
  const CLOUD_ICO = '<svg class="ico ico--sm" aria-hidden="true"><use href="#i-cloud"/></svg>';
  function renderLiveBanner() {
    const el = document.getElementById('live-banner');
    const quiet = document.getElementById('live-status');
    const L = window.SpotiLive;
    const s = state.accounts ? accountOf(state.slot) : null;
    // Stan automatu: gdy wszystko gra — mała linijka pod zakresem; problemy — wyraźny baner.
    let html = '';
    let warn = false;
    let calm = '';
    if (!s || !L || (state.meta && state.meta.demo)) {
      calm = '';
    } else if (!s.connectedAt) {
      calm = `Nowe odsłuchy mogą dociągać się same — <a href="./spotify.html${state.slot > 1 ? `?konto=${state.slot}` : ''}">włącz automat</a>`;
    } else if (s.error === 'invalid_grant') {
      warn = true;
      html = `${WARN_ICO} Logowanie automatu do Spotify wygasło, więc nowe odsłuchy się nie dociągają. <a href="./spotify.html?konto=${state.slot}">Zaloguj się ponownie</a>.`;
    } else if (L.tokenAgeDays(s) > L.TOKEN_LIFETIME_DAYS - 14) {
      warn = true;
      html = `${WARN_ICO} Logowanie automatu do Spotify wygaśnie za ok. ${Math.max(0, Math.round(L.TOKEN_LIFETIME_DAYS - L.tokenAgeDays(s)))} dni. <a href="./spotify.html?konto=${state.slot}">Odnów je</a>.`;
    } else if (s.error) {
      warn = true;
      html = `${WARN_ICO} Ostatnia synchronizacja automatu się nie udała. <a href="./spotify.html">Szczegóły</a>.`;
    } else if (s.lastSync) {
      const agoMin = Math.max(0, Math.floor((Date.now() - Date.parse(s.lastSync)) / 60_000));
      if (agoMin > 6 * 60) {
        warn = true;
        html = `${WARN_ICO} Automat nie synchronizował się od ${Math.floor(agoMin / 60)} godz. Coś się zacięło — <a href="./spotify.html">sprawdź</a>.`;
      } else {
        const ago = agoMin < 1 ? 'przed chwilą' : agoMin < 60 ? `${agoMin} min temu` : `${Math.floor(agoMin / 60)} godz. temu`;
        calm = `<span class="live-dot" aria-hidden="true"></span>Na bieżąco · synchronizacja ${ago}` +
          (state.liveAdded ? ` · +${nf.format(state.liveAdded)} z automatu` : '');
      }
    }
    quiet.innerHTML = calm;
    quiet.classList.toggle('hidden', !calm);

    if (state.cloudMsg) {
      html = `${state.cloudMsg.warn ? WARN_ICO : CLOUD_ICO} ${esc(state.cloudMsg.text)} <button type="button" class="banner-x" data-dismiss-msg aria-label="Zamknij">×</button>`;
      warn = Boolean(state.cloudMsg.warn);
    } else if (state.saveWarning) {
      html = `${WARN_ICO} ${esc(state.saveWarning)}`;
      warn = true;
    }
    el.innerHTML = html;
    el.classList.toggle('hidden', !html);
    el.classList.toggle('live-banner--warn', warn);
  }

  // ─────────────────────────────────────────────────────── ZAPIS NA GITHUBIE
  const TOKEN_KEY = 'ss_gh_token';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignoruj */ } };
  const cloudRepo = () => (window.SpotiLive ? window.SpotiLive.repo() : 'BartoszKrop/SpotiStats2.0');
  const hasExport = () => state.exportRows.length > 0 && !(state.meta && state.meta.demo);

  function setCloudMsg(text, warn = false) {
    state.cloudMsg = text ? { text, warn } : null;
    const st = document.getElementById('cloud-status');
    if (st) { st.textContent = text || ''; st.classList.toggle('cloud-status--error', Boolean(text && warn)); }
    renderLiveBanner();
  }

  function renderCloud() {
    const btn = document.getElementById('btn-cloud');
    if (!btn) return;
    btn.classList.toggle('hidden', !hasExport());
    const acc = accountOf(state.slot);
    const token = getToken();
    document.getElementById('cloud-token-box').classList.toggle('hidden', Boolean(token));
    document.getElementById('cloud-forget').classList.toggle('hidden', !token);
    document.getElementById('cloud-remove').classList.toggle('hidden', !acc.export);
    document.getElementById('cloud-name-box').classList.remove('hidden');
    const nameEl = document.getElementById('cloud-name');
    if (nameEl && document.activeElement !== nameEl && !nameEl.value) nameEl.value = acc.name || '';
    document.getElementById('cloud-send').disabled = state.cloudBusy || !hasExport();
  }

  function openCloud() {
    const panel = document.getElementById('cloud-panel');
    panel.classList.remove('hidden');
    renderCloud();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!getToken()) document.getElementById('cloud-token').focus({ preventScroll: true });
  }

  async function reloadAccounts() {
    const L = window.SpotiLive;
    if (!L || location.protocol === 'file:') return;
    try { state.accounts = await L.loadAccounts(); } catch { /* zostają stare dane */ }
    render();
  }

  async function cloudSend() {
    if (state.cloudBusy || !hasExport()) return;
    const typed = document.getElementById('cloud-token').value.trim();
    const token = typed || getToken();
    if (!token) { setCloudMsg('Wklej najpierw token z GitHuba (instrukcja powyżej).', true); return; }
    if (!window.SpotiCloud) { setCloudMsg('Brak modułu zapisu (cloud.js).', true); return; }
    const slot = state.slot;
    const name = document.getElementById('cloud-name').value.trim() || accountOf(slot).name || null;
    const importedAt = (state.meta && state.meta.importedAt) || Date.now();
    state.cloudBusy = true;
    renderCloud();
    try {
      const manifest = await window.SpotiCloud.upload({
        token, repo: cloudRepo(), slot, rows: state.exportRows, meta: { importedAt, name },
        onProgress: (t) => setCloudMsg(t)
      });
      setToken(token);
      document.getElementById('cloud-token').value = '';
      state.meta = { ...state.meta, importedAt: manifest.importedAt };
      try { await saveData(slot, { rows: state.exportRows, meta: state.meta }); } catch { /* ignoruj */ }
      setCloudMsg(`${state.importNote ? `${state.importNote} ` : ''}Zapisano na GitHubie. Na innych urządzeniach pojawi się po odświeżeniu strony (do kilku minut).`);
      state.importNote = '';
      await reloadAccounts();
    } catch (err) {
      setCloudMsg(err.message || 'Nie udało się zapisać na GitHubie.', true);
    } finally {
      state.cloudBusy = false;
      renderCloud();
    }
  }

  async function cloudRemove() {
    const token = getToken() || document.getElementById('cloud-token').value.trim();
    if (!token) { setCloudMsg('Wklej token z GitHuba, żeby usunąć eksport.', true); return; }
    if (!confirm('Usunąć eksport tego konta z GitHuba? (Wgrane w przeglądarce zostaje.)')) return;
    state.cloudBusy = true;
    try {
      await window.SpotiCloud.remove({ token, repo: cloudRepo(), slot: state.slot });
      setCloudMsg('Usunięto z GitHuba.');
      await reloadAccounts();
    } catch (err) {
      setCloudMsg(err.message || 'Nie udało się usunąć.', true);
    } finally {
      state.cloudBusy = false;
      renderCloud();
    }
  }

  /** Jeśli na GitHubie jest nowszy eksport niż w tej przeglądarce (albo nie ma żadnego) — wczytaj go. */
  async function maybeLoadCloudExport(slot) {
    const L = window.SpotiLive;
    const acc = accountOf(slot);
    if (!L || !acc.export || state.cloudLoading === slot) return;
    const localAt = state.exportRows.length && state.meta && !state.meta.demo ? state.meta.importedAt || 0 : 0;
    if (acc.export.importedAt <= localAt + 1000) return;
    state.cloudLoading = slot;
    const status = document.getElementById('import-status');
    if (!state.exportRows.length) render();
    try {
      const rows = await L.loadExportRows(acc);
      if (state.slot !== slot || !rows.length) return;
      const meta = { format: 'extended', importedAt: acc.export.importedAt, fromCloud: true, usedFiles: acc.export.files, podcasts: 0, duplicates: 0 };
      setData(rows, meta);
      status.textContent = '';
      try { await saveData(slot, { rows, meta }); } catch { /* cache nie jest konieczny */ }
    } catch {
      if (!state.exportRows.length) status.textContent = 'Nie udało się wczytać eksportu z GitHuba — spróbuj odświeżyć stronę.';
    } finally {
      state.cloudLoading = null;
      if (!state.rows.length) render();
    }
  }

  function wireCloud() {
    document.getElementById('btn-cloud').addEventListener('click', () => { closeMenu(); openCloud(); });
    document.getElementById('cloud-close').addEventListener('click', () => document.getElementById('cloud-panel').classList.add('hidden'));
    document.getElementById('cloud-send').addEventListener('click', cloudSend);
    document.getElementById('cloud-remove').addEventListener('click', cloudRemove);
    document.getElementById('cloud-forget').addEventListener('click', () => { setToken(''); setCloudMsg('Token usunięty z tej przeglądarki.'); renderCloud(); });
    document.getElementById('cloud-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') cloudSend(); });
  }

  /** Podświetla w menu sekcję, którą akurat czytasz. */
  function wireScrollSpy() {
    if (!('IntersectionObserver' in window)) return;
    const links = [...document.querySelectorAll('.side-link[href^="#"]')];
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

  /** Bez przypadkowego przybliżania: szczypanie i podwójne stuknięcie (iOS ignoruje user-scalable=no). */
  function blockZoom() {
    const stop = (e) => e.preventDefault();
    document.addEventListener('gesturestart', stop, { passive: false });
    document.addEventListener('gesturechange', stop, { passive: false });
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
    // Podwójne stuknięcie blokuje CSS: touch-action: manipulation.
  }

  async function init() {
    blockZoom();
    loadPrefs();
    state.booting = Boolean(window.SpotiLive) && location.protocol !== 'file:';
    wire();
    wireScrollSpy();
    wireCloud();
    renderAccounts();
    if (!state.profile) showWho();
    await loadSlot(state.slot);
    loadAccounts();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
