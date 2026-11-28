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
 *   okladki.json                   — okładki albumów („wykonawca|album” małymi literami → { img, at })
 *
 * Szyfrowanie: gdy w repo jest szyfr.json, a w sekrecie SPOTISTATS_HASLO hasło do strony, każdy plik
 * jest zapisywany zaszyfrowany (crypt.js), a jawne pliki z dawnych zapisów są szyfrowane przy okazji.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SpotiCrypt = createRequire(import.meta.url)('../crypt.js');

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

// ─────────────────────────────────────────────── odczyt/zapis (z szyfrowaniem)

/** Klucz z hasła (SPOTISTATS_HASLO) — null = zapis jawny. */
let dataKey = null;

const DEFAULT_CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'szyfr.json');

/**
 * Ustawia szyfrowanie na ten przebieg. Bez szyfr.json — jak dawniej (jawnie).
 * Z szyfr.json, ale bez sekretu — zapis jawny z ostrzeżeniem (dopóki ktoś nie doda sekretu).
 */
export async function initCrypto(env = process.env, configPath = env.SPOTISTATS_CONFIG || DEFAULT_CONFIG) {
  dataKey = null;
  let config = null;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch { /* brak szyfrowania */ }
  if (!config) return { mode: 'jawne' };
  if (!env.SPOTISTATS_HASLO) {
    console.log('::warning::Brak sekretu SPOTISTATS_HASLO — dane zapisują się jeszcze bez szyfrowania. Dodaj go w Settings → Secrets and variables → Actions.');
    return { mode: 'bez-hasla' };
  }
  const key = await SpotiCrypt.unlock(env.SPOTISTATS_HASLO, config);
  if (!key) throw new Error('Sekret SPOTISTATS_HASLO nie pasuje do szyfr.json (inne hasło niż na stronie).');
  dataKey = key;
  return { mode: 'szyfrowane' };
}
export const resetCrypto = () => { dataKey = null; };

async function readJson(path, fallback) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
  // Zaszyfrowany plik bez klucza to błąd, nie „brak pliku” — inaczej nadpisalibyśmy dane pustymi.
  return SpotiCrypt.readParsed(parsed, dataKey);
}
async function writeJson(path, data) {
  const text = JSON.stringify(data, null, 1);
  await writeFile(path, (dataKey ? JSON.stringify(await SpotiCrypt.seal(text, dataKey)) : text) + '\n');
}

/** Szyfruje wszystkie jawne pliki .json w katalogu danych (np. zapisane przed włączeniem hasła). Zwraca ich liczbę. */
export async function encryptAll(root) {
  if (!dataKey) return 0;
  let count = 0;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith('.json')) continue;
      let parsed;
      try { parsed = JSON.parse(await readFile(p, 'utf8')); } catch { continue; }
      if (SpotiCrypt.isBox(parsed)) continue;
      await writeJson(p, parsed);
      count++;
    }
  };
  await walk(root);
  if (count) console.log(`Zaszyfrowano ${count} plików z danymi.`);
  return count;
}

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
    return { added, accessToken, items };
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
export function pickImage(images, min = 320) {
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
    .filter((n) => { const e = known[n.toLowerCase()]; return !e || (!e.img && Date.parse(e.at || 0) < retryBefore) || (e.img && !e.hq); })
    .slice(0, max);
  let found = 0;
  for (const name of todo) {
    const url = `${SEARCH_URL}?type=artist&limit=5&q=${encodeURIComponent(name)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) break; // limit zapytań — dokończymy w następnej godzinie
    if (!res.ok) throw new Error(`Spotify search: ${res.status}`);
    const items = (await res.json())?.artists?.items || [];
    const hit = items.find((a) => a && String(a.name).toLowerCase() === name.toLowerCase());
    const img = hit ? pickImage(hit.images, 300) : null;
    if (img) found++;
    known[name.toLowerCase()] = { name, img, hq: true, at: new Date(now).toISOString() };
  }
  if (todo.length) {
    await writeJson(path, known);
    console.log(`Zdjęcia wykonawców: sprawdzono ${todo.length}, znaleziono ${found}.`);
  }
  return { checked: todo.length, found };
}

/**
 * Dokładne zdjęcia z świeżo pobranych odsłuchów: okładki albumów prosto z utworów oraz zdjęcia wykonawców
 * po ich identyfikatorach (bez zgadywania po nazwie — nie pomyli tezek ani imienników).
 */
export async function recordFreshImages(root, accessToken, items, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const covers = await readJson(join(root, 'okladki.json'), {});
  const artists = await readJson(join(root, 'wykonawcy.json'), {});
  const ids = new Map(); // id -> nazwa
  let newCovers = 0;
  for (const it of items) {
    const t = it.track || {};
    const artist = t.artists?.[0];
    if (!artist) continue;
    if (artist.id && artist.name) ids.set(artist.id, artist.name);
    const img = t.album?.images?.length ? pickImage(t.album.images, 100) : null;
    if (img && t.album?.name) {
      const key = coverKey(artist.name, t.album.name);
      if (covers[key]?.img !== img) newCovers++;
      covers[key] = { img, at, exact: true };
    }
  }
  const need = [...ids.keys()].filter((id) => { const e = artists[ids.get(id).toLowerCase()]; return !e || !e.exact || !e.img; }).slice(0, 50);
  let newArtists = 0;
  if (need.length) {
    const res = await fetch(`https://api.spotify.com/v1/artists?ids=${need.join(',')}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.ok) {
      for (const a of (await res.json())?.artists || []) {
        if (!a) continue;
        const img = pickImage(a.images, 300);
        if (!img) continue;
        artists[String(a.name).toLowerCase()] = { name: a.name, img, hq: true, exact: true, at };
        newArtists++;
      }
    }
  }
  if (newCovers) await writeJson(join(root, 'okladki.json'), covers);
  if (newArtists) await writeJson(join(root, 'wykonawcy.json'), artists);
  if (newCovers || newArtists) console.log(`Dokładne obrazy z odsłuchów: okładki ${newCovers}, wykonawcy ${newArtists}.`);
  return { newCovers, newArtists };
}

export const coverKey = (artist, album) => `${String(artist).toLowerCase()}|${String(album).toLowerCase()}`;

/** Okładki albumów (wyszukiwanie po albumie i wykonawcy, tylko dokładne dopasowanie nazwy albumu). */
export async function updateAlbumCovers(root, accessToken, pairs, { max = IMAGES_PER_RUN, now = Date.now() } = {}) {
  const path = join(root, 'okladki.json');
  const known = await readJson(path, {});
  const retryBefore = now - IMAGE_RETRY_DAYS * 86_400_000;
  const seen = new Set();
  const todo = [];
  for (const { artist, album } of pairs) {
    if (!artist || !album) continue;
    const key = coverKey(artist, album);
    if (seen.has(key)) continue;
    seen.add(key);
    const e = known[key];
    if (!e || (!e.img && Date.parse(e.at || 0) < retryBefore)) todo.push({ key, artist, album });
    if (todo.length >= max) break;
  }
  let found = 0;
  for (const { key, artist, album } of todo) {
    const q = `album:${album.replace(/"/g, '')} artist:${artist.replace(/"/g, '')}`;
    const res = await fetch(`${SEARCH_URL}?type=album&limit=5&q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) break;
    if (!res.ok) throw new Error(`Spotify search: ${res.status}`);
    const items = (await res.json())?.albums?.items || [];
    const hit = items.find((a) => a && String(a.name).toLowerCase() === album.toLowerCase());
    const img = hit ? pickImage(hit.images, 100) : null;
    if (img) found++;
    known[key] = { img, at: new Date(now).toISOString() };
  }
  if (todo.length) {
    await writeJson(path, known);
    console.log(`Okładki albumów: sprawdzono ${todo.length}, znaleziono ${found}.`);
  }
  return { checked: todo.length, found };
}

/** Wykonawcy i albumy z odsłuchów konta, od najczęściej słuchanych. */
async function listened(dir) {
  const status = await readJson(join(dir, 'status.json'), {});
  const artists = new Map();
  const albums = new Map();
  for (const f of status.files || []) {
    for (const r of await readJson(join(dir, f), [])) {
      const artist = r.master_metadata_album_artist_name;
      const album = r.master_metadata_album_album_name;
      if (!artist) continue;
      artists.set(artist, (artists.get(artist) || 0) + (r.ms_played || 0));
      if (album) {
        const key = coverKey(artist, album);
        const e = albums.get(key) || { artist, album, ms: 0 };
        e.ms += r.ms_played || 0;
        albums.set(key, e);
      }
    }
  }
  return {
    artists: [...artists.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    albums: [...albums.values()].sort((a, b) => b.ms - a.ms)
  };
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
      const { accessToken, items = [] } = await sync(dir, env);
      try {
        await recordFreshImages(root, accessToken, items);
        const heard = await listened(dir);
        await updateArtistImages(root, accessToken, heard.artists);
        await updateAlbumCovers(root, accessToken, heard.albums);
      } catch (err) {
        console.error(`Zdjęcia i okładki (konto ${slot}): ${err.message}`); // nie psuje synchronizacji
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
  (async () => {
    await initCrypto();
    await run(dir).finally(async () => {
      // Szyfrujemy też wtedy, gdy synchronizacja części kont się nie udała.
      const n = await encryptAll(dir);
      if (n && process.env.SPOTISTATS_ZNACZNIK) await writeFile(process.env.SPOTISTATS_ZNACZNIK, String(n));
    });
  })().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
