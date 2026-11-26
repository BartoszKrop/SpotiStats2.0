#!/usr/bin/env node
/*
 * Automatyczne dociąganie odsłuchów ze Spotify (uruchamiane przez GitHub Actions).
 *
 *   node scripts/spotify-sync.mjs connect <katalog-danych>   — wymienia kod z logowania na token (konto SPOTIFY_SLOT)
 *   node scripts/spotify-sync.mjs sync <katalog-danych>      — co godzinę: dopisuje nowe odsłuchy wszystkich kont
 *   node scripts/spotify-sync.mjs disconnect <katalog-danych> — usuwa konto SPOTIFY_SLOT (token i odsłuchy)
 *
 * Zmienne środowiskowe: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_CODE (connect),
 * SPOTIFY_SLOT (1–5), SPOTIFY_NAME (opcjonalna nazwa konta),
 * GITHUB_REPOSITORY (do ustalenia adresu powrotu na GitHub Pages).
 *
 * Układ katalogu danych (gałąź „dane”):
 *   konta.json                     — lista 5 miejsc: kto jest podłączony, stan, pliki
 *   konta/<n>/status.json          — kiedy ostatnia synchronizacja, kiedy połączono, ewentualny błąd
 *   konta/<n>/token.json           — refresh token zaszyfrowany AES-256-GCM kluczem z SPOTIFY_CLIENT_SECRET
 *   konta/<n>/odsluchy/<rok>.json  — odsłuchy w formacie rozszerzonego eksportu Spotify
 *   wykonawcy.json                 — zdjęcia wykonawców (nazwa małymi literami → { name, img, at })
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const RECENT_URL = 'https://api.spotify.com/v1/me/player/recently-played?limit=50';
const ME_URL = 'https://api.spotify.com/v1/me';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
/** Ile nowych wykonawców szukać w jednym przebiegu (reszta w kolejnych godzinach). */
const IMAGES_PER_RUN = 40;
/** Wykonawcę bez zdjęcia sprawdzamy ponownie po tylu dniach. */
const IMAGE_RETRY_DAYS = 30;
export const SLOTS = 5; // tryb developerski Spotify: właściciel + 4 osoby

// ─────────────────────────────────────────────── szyfrowanie tokenu

function keyFrom(secret) {
  return createHash('sha256').update(`spotistats-token:${secret}`).digest();
}

export function encryptToken(token, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptToken(box, secret) {
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

// ─────────────────────────────────────────────── konwersja i scalanie

/** Element z /me/player/recently-played → wiersz w formacie rozszerzonego eksportu. */
export function itemToRow(item) {
  const t = item.track || {};
  return {
    ts: new Date(item.played_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    // API nie podaje, ile faktycznie słuchano — zwraca tylko utwory grane ≥30 s,
    // więc przyjmujemy długość utworu.
    ms_played: t.duration_ms || 0,
    master_metadata_track_name: t.name || null,
    master_metadata_album_artist_name: t.artists?.[0]?.name || null,
    master_metadata_album_album_name: t.album?.name || null,
    spotify_track_uri: t.uri || null,
    source: 'api'
  };
}

/** Dokleja nowe wiersze do istniejących (po roku), bez duplikatów. Zwraca liczbę dodanych. */
export function mergeRows(byYear, newRows) {
  let added = 0;
  for (const row of newRows) {
    if (!row.master_metadata_track_name || !row.ts) continue;
    const year = row.ts.slice(0, 4);
    const list = (byYear[year] ||= []);
    if (list.some((r) => r.ts === row.ts && r.spotify_track_uri === row.spotify_track_uri)) continue;
    list.push(row);
    added++;
  }
  for (const list of Object.values(byYear)) list.sort((a, b) => a.ts.localeCompare(b.ts));
  return added;
}

export function redirectUri(repository) {
  const [owner, repo] = String(repository || '').split('/');
  if (!owner || !repo) throw new Error('Brak GITHUB_REPOSITORY (owner/repo).');
  return `https://${owner.toLowerCase()}.github.io/${repo}/spotify.html`;
}

// ─────────────────────────────────────────────── Spotify

async function tokenRequest(params, env) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: new URLSearchParams(params)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Spotify odrzucił token (${res.status}): ${body.error || ''} ${body.error_description || ''}`.trim());
    err.code = body.error;
    throw err;
  }
  return body;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 1) + '\n');

function requireEnv(env, names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length) throw new Error(`Brak sekretów/zmiennych: ${missing.join(', ')}. Dodaj je w Settings → Secrets and variables → Actions.`);
}

export async function connect(dir, env = process.env) {
  requireEnv(env, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_CODE']);
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code: env.SPOTIFY_CODE.trim(),
    redirect_uri: redirectUri(env.GITHUB_REPOSITORY)
  }, env);
  if (!tokens.refresh_token) throw new Error('Spotify nie zwrócił refresh tokenu.');
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'token.json'), encryptToken(tokens.refresh_token, env.SPOTIFY_CLIENT_SECRET));
  const status = await readJson(join(dir, 'status.json'), {});
  Object.assign(status, { connectedAt: new Date().toISOString(), error: null, errorAt: null });
  if (env.SPOTIFY_NAME && env.SPOTIFY_NAME.trim()) status.name = env.SPOTIFY_NAME.trim().slice(0, 40);
  else if (!status.name) {
    try {
      const me = await fetch(ME_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (me.ok) status.name = ((await me.json()).display_name || '').slice(0, 40) || null;
    } catch { /* nazwa nie jest konieczna */ }
  }
  await writeJson(join(dir, 'status.json'), status);
  console.log('Połączono ze Spotify. Token zapisany (zaszyfrowany).');
  // Od razu pierwsza synchronizacja.
  await sync(dir, env, tokens.access_token);
}

export async function sync(dir, env = process.env, accessToken = null) {
  const statusPath = join(dir, 'status.json');
  const status = await readJson(statusPath, {});
  const box = await readJson(join(dir, 'token.json'), null);
  if (!accessToken && !box) {
    // Zanim ktoś skonfiguruje automat, cogodzinne uruchomienia kończą się po cichu (bez czerwonych maili).
    console.log('Jeszcze nie połączono ze Spotify — instrukcja na stronie spotify.html. Pomijam.');
    return { added: 0, skipped: true };
  }
  requireEnv(env, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);

  try {
    if (!accessToken) {
      const refresh = decryptToken(box, env.SPOTIFY_CLIENT_SECRET);
      const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh }, env);
      accessToken = tokens.access_token;
      // Spotify czasem wydaje nowy refresh token — wtedy go podmieniamy.
      if (tokens.refresh_token && tokens.refresh_token !== refresh) {
        await writeJson(join(dir, 'token.json'), encryptToken(tokens.refresh_token, env.SPOTIFY_CLIENT_SECRET));
      }
    }

    const res = await fetch(RECENT_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Spotify API: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    const { items = [] } = await res.json();

    const folder = join(dir, 'odsluchy');
    await mkdir(folder, { recursive: true });
    const years = [...new Set(items.map((i) => new Date(i.played_at).toISOString().slice(0, 4)))];
    const byYear = {};
    for (const y of years) byYear[y] = await readJson(join(folder, `${y}.json`), []);
    const added = mergeRows(byYear, items.map(itemToRow));
    for (const y of years) await writeJson(join(folder, `${y}.json`), byYear[y]);

    const files = new Set(status.files || []);
    for (const y of years) files.add(`odsluchy/${y}.json`);
    const newest = items.map((i) => i.played_at).sort().pop();
    Object.assign(status, {
      lastSync: new Date().toISOString(),
      lastPlayedAt: [status.lastPlayedAt, newest].filter(Boolean).sort().pop() || null,
      files: [...files].sort(),
      error: null,
      errorAt: null
    });
    await writeJson(statusPath, status);
    console.log(`Pobrano ${items.length} ostatnich utworów, nowych: ${added}.`);
    return { added, accessToken };
  } catch (err) {
    // Błąd zapisujemy, żeby strona mogła go pokazać (np. wygasłe logowanie po 6 miesiącach).
    Object.assign(status, {
      error: err.code === 'invalid_grant' ? 'invalid_grant' : String(err.message).slice(0, 300),
      errorAt: new Date().toISOString()
    });
    await writeJson(statusPath, status);
    throw err;
  }
}

// ─────────────────────────────────────────────── zdjęcia wykonawców

/** Najmniejsze zdjęcie, które ma co najmniej `min` px (Spotify zwraca je od największego). */
export function pickImage(images, min = 160) {
  const list = (images || []).filter((i) => i && i.url);
  if (!list.length) return null;
  const ok = list.filter((i) => !i.width || i.width >= min);
  return (ok.length ? ok[ok.length - 1] : list[0]).url;
}

/**
 * Dopisuje do wykonawcy.json zdjęcia wykonawców o podanych nazwach (wyszukiwanie po nazwie,
 * tylko dokładne dopasowanie). Brak zdjęcia też zapamiętujemy, żeby nie pytać co godzinę.
 */
export async function updateArtistImages(root, accessToken, names, { max = IMAGES_PER_RUN, now = Date.now() } = {}) {
  const path = join(root, 'wykonawcy.json');
  const known = await readJson(path, {});
  const retryBefore = now - IMAGE_RETRY_DAYS * 86_400_000;
  const todo = [...new Set(names.filter(Boolean))]
    .filter((n) => { const e = known[n.toLowerCase()]; return !e || (!e.img && Date.parse(e.at || 0) < retryBefore); })
    .slice(0, max);
  let found = 0;
  for (const name of todo) {
    const url = `${SEARCH_URL}?type=artist&limit=5&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) break; // limit zapytań — dokończymy w następnej godzinie
    if (!res.ok) throw new Error(`Spotify search: ${res.status}`);
    const items = (await res.json())?.artists?.items || [];
    const hit = items.find((a) => a && String(a.name).toLowerCase() === name.toLowerCase());
    const img = hit ? pickImage(hit.images) : null;
    if (img) found++;
    known[name.toLowerCase()] = { name, img, at: new Date(now).toISOString() };
  }
  if (todo.length) {
    await writeJson(path, known);
    console.log(`Zdjęcia wykonawców: sprawdzono ${todo.length}, znaleziono ${found}.`);
  }
  return { checked: todo.length, found };
}

/** Nazwy wykonawców z odsłuchów konta, od najczęściej słuchanych. */
async function artistNames(dir) {
  const status = await readJson(join(dir, 'status.json'), {});
  const count = new Map();
  for (const f of status.files || []) {
    for (const r of await readJson(join(dir, f), [])) {
      const n = r.master_metadata_album_artist_name;
      if (n) count.set(n, (count.get(n) || 0) + (r.ms_played || 0));
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

// ─────────────────────────────────────────────── wiele kont

const exists = (p) => stat(p).then(() => true, () => false);
const slotDir = (root, slot) => join(root, 'konta', String(slot));

function parseSlot(env) {
  const slot = Number(env.SPOTIFY_SLOT || 1);
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOTS) throw new Error(`Numer konta musi być od 1 do ${SLOTS}.`);
  return slot;
}

/** Dane z pierwszej wersji (jedno konto w katalogu głównym) przenosimy do konta nr 1. */
export async function migrateLegacy(root) {
  if (!(await exists(join(root, 'token.json'))) || (await exists(join(slotDir(root, 1), 'token.json')))) return false;
  await mkdir(slotDir(root, 1), { recursive: true });
  for (const name of ['token.json', 'status.json', 'odsluchy']) {
    if (await exists(join(root, name))) await rename(join(root, name), join(slotDir(root, 1), name));
  }
  console.log('Przeniesiono dotychczasowe dane do konta nr 1.');
  return true;
}

/** konta.json — publiczny spis miejsc, z którego korzysta strona. */
export async function writeIndex(root) {
  const list = [];
  for (let slot = 1; slot <= SLOTS; slot++) {
    const st = await readJson(join(slotDir(root, slot), 'status.json'), null);
    list.push(st && st.connectedAt
      ? { slot, name: st.name || null, connectedAt: st.connectedAt, lastSync: st.lastSync || null, lastPlayedAt: st.lastPlayedAt || null, error: st.error || null, files: st.files || [] }
      : { slot, name: null });
  }
  await writeJson(join(root, 'konta.json'), { slots: list, updatedAt: new Date().toISOString() });
  return list;
}

export async function connectSlot(root, env = process.env) {
  const slot = parseSlot(env);
  await migrateLegacy(root);
  await connect(slotDir(root, slot), env);
  await writeIndex(root);
  console.log(`Konto nr ${slot} połączone.`);
}

export async function syncAll(root, env = process.env) {
  await migrateLegacy(root);
  const failures = [];
  let connected = 0;
  for (let slot = 1; slot <= SLOTS; slot++) {
    const dir = slotDir(root, slot);
    if (!(await exists(join(dir, 'token.json')))) continue;
    connected++;
    try {
      const { accessToken } = await sync(dir, env);
      try {
        await updateArtistImages(root, accessToken, await artistNames(dir));
      } catch (err) {
        console.error(`Zdjęcia wykonawców (konto ${slot}): ${err.message}`); // nie psuje synchronizacji
      }
    } catch (err) {
      console.error(`Konto ${slot}: ${err.message}`);
      // Wygasłe logowanie jednej osoby to nie awaria całego automatu — strona pokaże baner.
      if (err.code !== 'invalid_grant') failures.push(`konto ${slot}: ${err.message}`);
    }
  }
  if (!connected) console.log('Jeszcze nikt nie jest połączony — instrukcja na stronie spotify.html. Pomijam.');
  await writeIndex(root);
  if (failures.length) throw new Error(failures.join('; '));
}

export async function disconnectSlot(root, env = process.env) {
  const slot = parseSlot(env);
  await migrateLegacy(root);
  await rm(slotDir(root, slot), { recursive: true, force: true });
  await writeIndex(root);
  console.log(`Konto nr ${slot} odłączone, jego dane usunięte.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [mode, dir = 'dane'] = process.argv.slice(2);
  const run = { connect: connectSlot, sync: syncAll, disconnect: disconnectSlot }[mode];
  if (!run) {
    console.error('Użycie: node scripts/spotify-sync.mjs connect|sync|disconnect <katalog>');
    process.exit(2);
  }
  run(dir).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
