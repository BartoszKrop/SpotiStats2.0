/*
 * SpotiStats — odczyt automatycznie dociąganych odsłuchów z gałęzi „dane”
 * (zapisuje je workflow .github/workflows/spotify-sync.yml).
 * window.SpotiLive = { repo, rawUrl, actionsUrl, loadStatus, loadRows, tokenAgeDays }
 */
(function (root) {
  'use strict';

  const DEFAULT_REPO = 'BartoszKrop/SpotiStats2.0';
  const BRANCH = 'dane';
  /** Spotify unieważnia logowanie aplikacji po 6 miesiącach. */
  const TOKEN_LIFETIME_DAYS = 182;

  /** owner/repo — z adresu GitHub Pages (np. bartoszkrop.github.io/SpotiStats2.0), inaczej domyślne. */
  function repo() {
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (m && seg && !/\.html$/i.test(seg)) {
      const [defOwner, defRepo] = DEFAULT_REPO.split('/');
      // Zachowaj oryginalną wielkość liter, jeśli to ten sam projekt.
      if (m[1].toLowerCase() === defOwner.toLowerCase() && seg.toLowerCase() === defRepo.toLowerCase()) return DEFAULT_REPO;
      return `${m[1]}/${seg}`;
    }
    return DEFAULT_REPO;
  }

  const rawUrl = (path) => `https://raw.githubusercontent.com/${repo()}/${BRANCH}/${path}`;
  const actionsUrl = () => `https://github.com/${repo()}/actions/workflows/spotify-sync.yml`;

  async function getJson(path) {
    // Parametr omija cache przeglądarki; raw.githubusercontent.com sam cache’uje do ~5 min.
    const res = await fetch(`${rawUrl(path)}?t=${Math.floor(Date.now() / 60_000)}`, { cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** null = automat jeszcze nie skonfigurowany (brak gałęzi/pliku). */
  function loadStatus() {
    return getJson('status.json');
  }

  /** Surowe wiersze (format rozszerzonego eksportu) ze wszystkich plików z odsłuchami. */
  async function loadRows(status) {
    const files = (status && status.files) || [];
    const parts = await Promise.all(files.map((f) => getJson(f).catch(() => null)));
    return parts.filter(Array.isArray).flat();
  }

  function tokenAgeDays(status) {
    if (!status || !status.connectedAt) return null;
    return (Date.now() - Date.parse(status.connectedAt)) / 86_400_000;
  }

  root.SpotiLive = { repo, rawUrl, actionsUrl, loadStatus, loadRows, tokenAgeDays, TOKEN_LIFETIME_DAYS };
})(globalThis);
