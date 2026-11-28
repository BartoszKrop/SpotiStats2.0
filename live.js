/*
 * SpotiStats — odczyt automatycznie dociąganych odsłuchów z gałęzi „dane”
 * (zapisuje je workflow .github/workflows/spotify-sync.yml).
 * Do 5 kont: konta.json + konta/<n>/odsluchy/<rok>.json.
 */
(function (root) {
  'use strict';

  const DEFAULT_REPO = 'BartoszKrop/SpotiStats2.0';
  /** Client ID aplikacji Spotify — to publiczny identyfikator (widać go w każdym linku logowania), nie sekret. */
  const CLIENT_ID = '07ef9b62455442ad8f53cb2b1b348b60';
  const BRANCH = 'dane';
  const SLOTS = 5;
  /** Spotify unieważnia logowanie aplikacji po 6 miesiącach. */
  const TOKEN_LIFETIME_DAYS = 182;

  /** owner/repo — z adresu GitHub Pages (np. bartoszkrop.github.io/SpotiStats2.0), inaczej domyślne. */
  function repo() {
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (m && seg && !/\.html$/i.test(seg)) {
      const [defOwner, defRepo] = DEFAULT_REPO.split('/');
      if (m[1].toLowerCase() === defOwner.toLowerCase() && seg.toLowerCase() === defRepo.toLowerCase()) return DEFAULT_REPO;
      return `${m[1]}/${seg}`;
    }
    return DEFAULT_REPO;
  }

  const rawUrl = (path) => `https://raw.githubusercontent.com/${repo()}/${BRANCH}/${path}`;
  const actionsUrl = () => `https://github.com/${repo()}/actions/workflows/spotify-sync.yml`;

  // ─── hasło: dane na gałęzi „dane” są zaszyfrowane (crypt.js), klucz trzymamy w tej przeglądarce
  const KEY_STORE = 'ss_klucz';
  let dataKey = null;
  const key = () => dataKey;

  /** szyfr.json leży obok strony (gałąź main). null = szyfrowanie wyłączone. */
  async function loadConfig() {
    const res = await fetch(`./szyfr.json?t=${Math.floor(Date.now() / 60_000)}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Klucz zapamiętany na tym urządzeniu. config = null (np. brak sieci) — bierzemy go bez sprawdzania. */
  async function restoreKey(config) {
    const C = root.SpotiCrypt;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY_STORE) || 'null'); } catch { /* brak localStorage */ }
    if (!C || !saved || !saved.k) return false;
    if (config && saved.salt !== config.salt) return false; // hasło zmienione
    try {
      const k = await C.importKey(saved.k);
      if (config && !(await C.verify(k, config))) return false;
      dataKey = k;
      return true;
    } catch { return false; }
  }

  /** Sprawdza hasło; dobre — zapamiętuje klucz na tym urządzeniu. */
  async function tryPassword(password, config) {
    const k = await root.SpotiCrypt.unlock(password, config);
    if (!k) return false;
    dataKey = k;
    try { localStorage.setItem(KEY_STORE, JSON.stringify({ salt: config.salt, k: await root.SpotiCrypt.exportKey(k) })); } catch { /* tylko na tę sesję */ }
    return true;
  }

  function forgetKey() {
    dataKey = null;
    try { localStorage.removeItem(KEY_STORE); } catch { /* ignoruj */ }
  }

  async function getJson(path) {
    // Parametr omija cache przeglądarki; raw.githubusercontent.com sam cache’uje do ~5 min.
    const res = await fetch(`${rawUrl(path)}?t=${Math.floor(Date.now() / 60_000)}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    return root.SpotiCrypt ? root.SpotiCrypt.readParsed(parsed, dataKey) : parsed;
  }

  const emptySlots = () => Array.from({ length: SLOTS }, (_, i) => ({ slot: i + 1, name: null }));

  /**
   * Lista 5 miejsc: [{ slot, name, connectedAt, lastSync, error, files, base }].
   * Zgodność wstecz: przed podziałem na konta dane leżały w katalogu głównym gałęzi — to konto nr 1.
   */
  async function loadAccounts() {
    const index = await getJson('konta.json');
    let slots;
    if (index && Array.isArray(index.slots)) {
      slots = emptySlots().map((e) => ({ ...e, ...(index.slots.find((s) => s.slot === e.slot) || {}), base: `konta/${e.slot}/` }));
    } else {
      const legacy = await getJson('status.json');
      slots = emptySlots().map((e) => ({ ...e, base: `konta/${e.slot}/` }));
      if (legacy && legacy.connectedAt) slots[0] = { ...slots[0], ...legacy, name: legacy.name || null, base: '' };
    }
    // Eksport wgrany na GitHuba (spis konta/<n>/eksport.json) — osobno od odsłuchów z automatu.
    await Promise.all(slots.map(async (s) => {
      const m = await getJson(`konta/${s.slot}/eksport.json`).catch(() => null);
      if (m && Array.isArray(m.files) && m.files.length) {
        s.export = m;
        if (!s.name && m.name) s.name = m.name;
      }
      // Profil (nazwa, zdjęcie, tło) ustawiony w aplikacji — ma pierwszeństwo przed nazwą z automatu.
      const p = await getJson(`konta/${s.slot}/profil.json`).catch(() => null);
      if (p && typeof p === 'object') {
        s.profile = p;
        if (p.name) s.name = p.name;
      }
    }));
    return slots;
  }

  /** Wiersze eksportu z GitHuba (zwarty format → wiersze). */
  async function loadExportRows(account) {
    const parts = await Promise.all(account.export.files.map((f) => getJson(`konta/${account.slot}/${f}`)));
    if (!root.SpotiCloud) throw new Error('brak cloud.js');
    return root.SpotiCloud.decodeRows(parts.filter(Boolean));
  }

  /** Surowe wiersze (format rozszerzonego eksportu) jednego konta. */
  async function loadRows(account) {
    const files = (account && account.files) || [];
    const parts = await Promise.all(files.map((f) => getJson(account.base + f).catch(() => null)));
    return parts.filter(Array.isArray).flat();
  }

  /** Zdjęcia wykonawców zebrane przez automat: Map(nazwa małymi literami → url). */
  async function loadArtistImages() {
    const data = (await getJson('wykonawcy.json')) || {};
    const map = new Map();
    for (const [k, v] of Object.entries(data)) if (v && v.img) map.set(k, v.img);
    return map;
  }

  /** Okładki albumów zebrane przez automat: Map(„wykonawca|album” małymi literami → url). */
  async function loadAlbumCovers() {
    const data = (await getJson('okladki.json')) || {};
    const map = new Map();
    for (const [k, v] of Object.entries(data)) if (v && v.img) map.set(k, v.img);
    return map;
  }

  function tokenAgeDays(account) {
    if (!account || !account.connectedAt) return null;
    return (Date.now() - Date.parse(account.connectedAt)) / 86_400_000;
  }

  root.SpotiLive = { key, loadConfig, restoreKey, tryPassword, forgetKey, CLIENT_ID, SLOTS, repo, rawUrl, actionsUrl, loadAccounts, loadRows, loadExportRows, loadArtistImages, loadAlbumCovers, tokenAgeDays, TOKEN_LIFETIME_DAYS };
})(globalThis);
