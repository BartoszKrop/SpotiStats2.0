/*
 * SpotiStats — zapis eksportu na GitHubie (gałąź „dane”), żeby był na każdym urządzeniu bez ponownego wgrywania.
 *
 * Układ na gałęzi:  konta/<n>/eksport.json            — spis (kiedy wgrano, nazwa, pliki)
 *                   konta/<n>/eksport/<rok>.json      — odsłuchy danego roku w zwartej postaci
 * Zapis idzie z przeglądarki przez API GitHuba, tokenem wpisanym raz i trzymanym tylko w tej przeglądarce.
 */
(function (root) {
  'use strict';

  const BRANCH = 'dane';
  const API = 'https://api.github.com';

  /** Wiersze (po normalizacji) → obiekty per rok: słowniki nazw + [sekundy, ms, wykonawca, utwór, album]. */
  function encodeRows(rows) {
    const years = new Map();
    for (const r of rows) {
      const year = new Date(r.t).getUTCFullYear();
      let y = years.get(year);
      if (!y) years.set(year, (y = { v: 1, a: [], t: [], b: [], r: [], ia: new Map(), it: new Map(), ib: new Map() }));
      const idx = (list, map, value) => {
        let i = map.get(value);
        if (i === undefined) { i = list.length; list.push(value); map.set(value, i); }
        return i;
      };
      y.r.push([Math.round(r.t / 1000), Math.round(r.ms), idx(y.a, y.ia, r.artist), idx(y.t, y.it, r.track), idx(y.b, y.ib, r.album || '')]);
    }
    const out = {};
    for (const [year, y] of years) out[year] = { v: 1, a: y.a, t: y.t, b: y.b, r: y.r };
    return out;
  }

  /** Odwrotność encodeRows: lista obiektów-lat → wiersze posortowane po czasie. */
  function decodeRows(parts) {
    const rows = [];
    for (const p of parts) {
      if (!p || !Array.isArray(p.r)) continue;
      for (const [sec, ms, a, t, b] of p.r) rows.push({ t: sec * 1000, artist: p.a[a], track: p.t[t], album: p.b[b], uri: '', ms });
    }
    rows.sort((x, y) => x.t - y.t);
    return rows;
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  class CloudError extends Error {}

  async function gh(token, repo, method, path, body) {
    const res = await fetch(`${API}/repos/${repo}/contents/${path}${method === 'GET' ? `?ref=${BRANCH}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) throw new CloudError('GitHub nie przyjął tokenu (zły albo wygasł). Wklej nowy.');
    if (res.status === 403 || (res.status === 404 && method !== 'GET')) throw new CloudError('Token nie ma prawa zapisu do tego repozytorium (potrzebne: Contents → Read and write).');
    return res;
  }

  async function getFile(token, repo, path) {
    const res = await gh(token, repo, 'GET', path);
    if (res.status === 404) return null;
    if (!res.ok) throw new CloudError(`GitHub: ${res.status}`);
    return res.json();
  }

  async function putFile(token, repo, path, text, message) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await getFile(token, repo, path);
      const res = await gh(token, repo, 'PUT', path, { message, content: toBase64(text), branch: BRANCH, ...(existing ? { sha: existing.sha } : {}) });
      if (res.ok) return;
      if (res.status !== 409 && res.status !== 422) throw new CloudError(`GitHub: ${res.status}`);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // równoległy zapis (np. automatu) — próbujemy jeszcze raz
    }
    throw new CloudError('GitHub: nie udało się zapisać (konflikt). Spróbuj za chwilę.');
  }

  async function deleteFile(token, repo, path, message) {
    const existing = await getFile(token, repo, path);
    if (!existing) return;
    const res = await gh(token, repo, 'DELETE', path, { message, sha: existing.sha, branch: BRANCH });
    if (!res.ok) throw new CloudError(`GitHub: ${res.status}`);
  }

  async function readManifest(token, repo, slot) {
    const f = await getFile(token, repo, `konta/${slot}/eksport.json`);
    if (!f) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(f.content.replace(/\n/g, ''))))); } catch { return null; }
  }

  /**
   * Wysyła wiersze konta na gałąź „dane”. onProgress(tekst) — do wyświetlania postępu.
   * meta: { importedAt, name }.
   */
  async function upload({ token, repo, slot, rows, meta, onProgress = () => {} }) {
    const byYear = encodeRows(rows);
    const years = Object.keys(byYear).sort();
    const old = await readManifest(token, repo, slot);
    let i = 0;
    for (const y of years) {
      onProgress(`Wysyłam ${y} (${++i}/${years.length})…`);
      await putFile(token, repo, `konta/${slot}/eksport/${y}.json`, JSON.stringify(byYear[y]), `Eksport konta ${slot}: ${y}`);
    }
    const files = years.map((y) => `eksport/${y}.json`);
    for (const f of (old && old.files) || []) {
      if (!files.includes(f)) await deleteFile(token, repo, `konta/${slot}/${f}`, `Eksport konta ${slot}: usunięto ${f}`);
    }
    const manifest = {
      v: 1,
      importedAt: (meta && meta.importedAt) || Date.now(),
      name: (meta && meta.name) || null,
      files,
      rows: rows.length,
      from: rows.length ? rows[0].t : null,
      to: rows.length ? rows[rows.length - 1].t : null
    };
    onProgress('Zapisuję spis…');
    await putFile(token, repo, `konta/${slot}/eksport.json`, JSON.stringify(manifest, null, 1), `Eksport konta ${slot}: spis`);
    return manifest;
  }

  /** Usuwa eksport konta z GitHuba (pliki lat i spis). Odsłuchy z automatu zostają. */
  async function remove({ token, repo, slot }) {
    const m = await readManifest(token, repo, slot);
    for (const f of (m && m.files) || []) await deleteFile(token, repo, `konta/${slot}/${f}`, `Eksport konta ${slot}: usunięto ${f}`);
    await deleteFile(token, repo, `konta/${slot}/eksport.json`, `Eksport konta ${slot}: usunięto spis`);
  }

  const API_EXPORT = { encodeRows, decodeRows, upload, remove, CloudError };
  if (typeof module === 'object' && module.exports) module.exports = API_EXPORT;
  else root.SpotiCloud = API_EXPORT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
