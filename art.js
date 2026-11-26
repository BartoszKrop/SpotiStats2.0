/*
 * SpotiStats — zdjęcia wykonawców i okładki pobierane w przeglądarce z publicznego API Deezera (bez klucza),
 * dla tych pozycji, których nie ma w danych z automatu (np. wykonawcy z eksportu wgranego tylko lokalnie).
 * Wyniki (także „brak zdjęcia”) są zapamiętywane w localStorage. Do Deezera trafiają tylko nazwy
 * wykonawców/albumów, nigdy odsłuchy ani godziny.
 */
(function (root) {
  'use strict';

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  /** Deezer zwraca „pusty” obrazek, gdy nie ma zdjęcia (adres z podwójnym ukośnikiem) — traktujemy go jak brak. */
  const real = (url) => (url && !/\/(artist|cover)\/\/[^/]*$/.test(url) ? url : null);

  function pickArtist(list, name) {
    const n = norm(name);
    const hit = (list || []).find((a) => a && norm(a.name) === n);
    return hit ? real(hit.picture_big) || real(hit.picture_medium) : null;
  }
  function pickAlbum(list, artist, album) {
    const al = norm(album), ar = norm(artist);
    const hit = (list || []).find((a) => a && norm(a.title) === al && norm(a.artist && a.artist.name) === ar)
      || (list || []).find((a) => a && norm(a.title) === al);
    return hit ? real(hit.cover_big) || real(hit.cover_medium) : null;
  }

  /** JSONP (Deezer nie wysyła nagłówków CORS, ale obsługuje wywołanie przez <script>). */
  function jsonp(url, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      const cb = `__art${Math.random().toString(36).slice(2)}`;
      const s = document.createElement('script');
      const done = (v, err) => { clearTimeout(t); delete window[cb]; s.remove(); if (err) reject(err); else resolve(v); };
      const t = setTimeout(() => done(null, new Error('timeout')), timeoutMs);
      window[cb] = (d) => done(d);
      s.onerror = () => done(null, new Error('jsonp'));
      s.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
      document.head.appendChild(s);
    });
  }

  function createLoader({ storage, fetchJson = jsonp, onChange = () => {}, now = Date.now, spacingMs = 130, parallel = 3, retryDays = 14 }) {
    const KEY = 'ss_art_v1';
    let db = {};
    try { db = JSON.parse(storage.getItem(KEY) || '{}') || {}; } catch { db = {}; }
    const queue = [];
    const queued = new Set();
    let running = 0, lastStart = 0, notifyTimer = null, idleResolvers = [], dirty = false;

    const aKey = (n) => `a:${norm(n)}`;
    const cKey = (ar, al) => `c:${norm(ar)}|${norm(al)}`;
    const known = (key) => db[key] && db[key].u;
    const fresh = (key) => db[key] && (db[key].u || now() - db[key].t < retryDays * 86_400_000);

    function save() { try { storage.setItem(KEY, JSON.stringify(db)); } catch { /* pełny magazyn — trudno */ } }
    function notify() {
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => { if (dirty) { dirty = false; save(); onChange(); } }, 600);
    }
    function checkIdle() { if (!running && !queue.length) { idleResolvers.forEach((r) => r()); idleResolvers = []; } }

    function pump() {
      while (running < parallel && queue.length) {
        const wait = lastStart + spacingMs - Date.now();
        if (wait > 0) { setTimeout(pump, wait); return; }
        lastStart = Date.now();
        const { key, url, pick } = queue.shift();
        running++;
        Promise.resolve().then(() => fetchJson(url))
          .then((d) => pick((d && d.data) || []))
          .catch(() => undefined) // błąd sieci: nie zapamiętujemy, spróbujemy przy następnej wizycie
          .then((u) => {
            if (u !== undefined) { db[key] = { u: u || null, t: now() }; dirty = true; notify(); }
            queued.delete(key);
            running--;
            pump();
            checkIdle();
          });
      }
      checkIdle();
    }
    function want(key, url, pick) {
      if (fresh(key) || queued.has(key)) return;
      queued.add(key);
      queue.push({ key, url, pick });
      pump();
    }

    return {
      /** Adres zdjęcia wykonawcy z pamięci (albo null); brakujące zleca do pobrania. */
      artist(name) {
        if (!name) return null;
        const key = aKey(name);
        if (known(key)) return db[key].u;
        want(key, `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`, (list) => pickArtist(list, name));
        return null;
      },
      /** Adres okładki albumu z pamięci (albo null); brakujące zleca do pobrania. */
      cover(artist, album) {
        if (!artist || !album) return null;
        const key = cKey(artist, album);
        if (known(key)) return db[key].u;
        want(key, `https://api.deezer.com/search/album?q=${encodeURIComponent(`artist:"${artist}" album:"${album}"`)}&limit=5`, (list) => pickAlbum(list, artist, album));
        return null;
      },
      whenIdle() { return running || queue.length ? new Promise((r) => idleResolvers.push(r)) : Promise.resolve(); },
      flush() { clearTimeout(notifyTimer); if (dirty) { dirty = false; save(); onChange(); } }
    };
  }

  const API = { norm, pickArtist, pickAlbum, jsonp, createLoader };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.SpotiArt = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
