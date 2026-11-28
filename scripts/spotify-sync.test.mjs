// Uruchom: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptToken, decryptToken, itemToRow, mergeRows, redirectUri, connect, sync, migrateLegacy, syncAll, connectSlot, disconnectSlot, pickImage, updateArtistImages, updateAlbumCovers, coverKey, recordFreshImages } from './spotify-sync.mjs';
import { stat } from 'node:fs/promises';

const item = (playedAt, name, artist = 'Artist') => ({
  played_at: playedAt,
  track: { name, duration_ms: 200000, uri: `spotify:track:${name}`, artists: [{ name: artist }, { name: 'Feat' }], album: { name: 'LP' } }
});

const env = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'sekret', GITHUB_REPOSITORY: 'BartoszKrop/SpotiStats2.0' };

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body } = handler(String(url), opts);
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

test('token szyfruje się i odszyfrowuje tylko właściwym sekretem', () => {
  const box = encryptToken('refresh-123', 'sekret');
  assert.ok(!JSON.stringify(box).includes('refresh-123'));
  assert.equal(decryptToken(box, 'sekret'), 'refresh-123');
  assert.throws(() => decryptToken(box, 'inny'));
});

test('itemToRow daje format rozszerzonego eksportu', () => {
  const row = itemToRow(item('2026-11-26T17:00:00.123Z', 'Song'));
  assert.deepEqual(row, {
    ts: '2026-11-26T17:00:00Z',
    ms_played: 200000,
    master_metadata_track_name: 'Song',
    master_metadata_album_artist_name: 'Artist',
    master_metadata_album_album_name: 'LP',
    spotify_track_uri: 'spotify:track:Song',
    source: 'api'
  });
});

test('mergeRows nie dubluje i dzieli po latach', () => {
  const byYear = { 2026: [itemToRow(item('2026-01-01T10:00:00Z', 'A'))] };
  const added = mergeRows(byYear, [
    itemToRow(item('2026-01-01T10:00:00Z', 'A')),
    itemToRow(item('2025-12-31T23:00:00Z', 'B')),
    itemToRow(item('2026-01-02T10:00:00Z', 'C'))
  ]);
  assert.equal(added, 2);
  assert.deepEqual(byYear['2026'].map((r) => r.master_metadata_track_name), ['A', 'C']);
  assert.equal(byYear['2025'].length, 1);
});

test('redirectUri wskazuje na GitHub Pages', () => {
  assert.equal(redirectUri('BartoszKrop/SpotiStats2.0'), 'https://bartoszkrop.github.io/SpotiStats2.0/spotify.html');
});

test('connect zapisuje zaszyfrowany token i od razu synchronizuje', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  const calls = mockFetch((url) => url.includes('/api/token')
    ? { body: { access_token: 'acc', refresh_token: 'ref' } }
    : { body: { items: [item('2026-11-26T10:00:00Z', 'X'), item('2026-11-26T09:00:00Z', 'Y')] } });
  await connect(dir, { ...env, SPOTIFY_CODE: ' kod ' });
  const tokenCall = calls[0];
  assert.match(tokenCall.opts.body.toString(), /grant_type=authorization_code&code=kod&redirect_uri=https%3A%2F%2Fbartoszkrop\.github\.io/);
  assert.equal(tokenCall.opts.headers.Authorization, 'Basic ' + Buffer.from('id:sekret').toString('base64'));
  assert.equal(decryptToken(JSON.parse(await readFile(join(dir, 'token.json'), 'utf8')), 'sekret'), 'ref');
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.ok(status.connectedAt);
  assert.deepEqual(status.files, ['odsluchy/2026.json']);
  assert.equal(status.lastPlayedAt, '2026-11-26T10:00:00Z');
  const rows = JSON.parse(await readFile(join(dir, 'odsluchy/2026.json'), 'utf8'));
  assert.deepEqual(rows.map((r) => r.master_metadata_track_name), ['Y', 'X']);
});

test('sync odświeża token, dopisuje tylko nowe i podmienia obrócony token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(dir, 'token.json'), JSON.stringify(encryptToken('stary', 'sekret')));
  await mkdir(join(dir, 'odsluchy'));
  await writeFile(join(dir, 'odsluchy/2026.json'), JSON.stringify([itemToRow(item('2026-11-26T09:00:00Z', 'Y'))]));
  await writeFile(join(dir, 'status.json'), JSON.stringify({ connectedAt: '2026-11-01T00:00:00Z', files: ['odsluchy/2026.json'] }));
  const calls = mockFetch((url) => url.includes('/api/token')
    ? { body: { access_token: 'acc', refresh_token: 'nowy' } }
    : { body: { items: [item('2026-11-26T10:00:00Z', 'X'), item('2026-11-26T09:00:00Z', 'Y')] } });
  const res = await sync(dir, env);
  assert.equal(res.added, 1);
  assert.match(calls[0].opts.body.toString(), /grant_type=refresh_token&refresh_token=stary/);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer acc');
  assert.equal(decryptToken(JSON.parse(await readFile(join(dir, 'token.json'), 'utf8')), 'sekret'), 'nowy');
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.equal(status.connectedAt, '2026-11-01T00:00:00Z');
  assert.equal(status.error, null);
});

test('sync zapisuje invalid_grant w statusie (wygasłe logowanie)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(dir, 'token.json'), JSON.stringify(encryptToken('stary', 'sekret')));
  mockFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }));
  await assert.rejects(() => sync(dir, env), /invalid_grant/);
  const status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
  assert.equal(status.error, 'invalid_grant');
});

test('sync bez połączenia (i bez sekretów) po prostu nic nie robi', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  const res = await sync(dir, {});
  assert.equal(res.skipped, true);
});

test('brak sekretów daje czytelny błąd', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(dir, 'token.json'), JSON.stringify(encryptToken('stary', 'sekret')));
  await assert.rejects(() => sync(dir, { GITHUB_REPOSITORY: 'a/b' }), /SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET/);
  await assert.rejects(() => connect(dir, { GITHUB_REPOSITORY: 'a/b' }), /SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_CODE/);
});

const exists = (p) => stat(p).then(() => true, () => false);

test('migracja: dotychczasowe dane z katalogu głównego trafiają do konta nr 1', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  await writeFile(join(root, 'token.json'), JSON.stringify(encryptToken('t', 'sekret')));
  await writeFile(join(root, 'status.json'), JSON.stringify({ connectedAt: '2026-11-26T18:30:00Z', files: ['odsluchy/2026.json'] }));
  await mkdir(join(root, 'odsluchy'));
  await writeFile(join(root, 'odsluchy/2026.json'), '[]');
  assert.equal(await migrateLegacy(root), true);
  assert.ok(await exists(join(root, 'konta/1/token.json')));
  assert.ok(await exists(join(root, 'konta/1/odsluchy/2026.json')));
  assert.equal(await exists(join(root, 'token.json')), false);
  assert.equal(await migrateLegacy(root), false);
});

test('syncAll: każde konto osobno, wygasłe logowanie nie wywala całości, konta.json ma 5 miejsc', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  for (const [slot, tok] of [[1, 'dobry'], [3, 'zly']]) {
    await mkdir(join(root, `konta/${slot}`), { recursive: true });
    await writeFile(join(root, `konta/${slot}/token.json`), JSON.stringify(encryptToken(tok, 'sekret')));
    await writeFile(join(root, `konta/${slot}/status.json`), JSON.stringify({ connectedAt: '2026-11-26T00:00:00Z', name: `Osoba ${slot}` }));
  }
  mockFetch((url, opts) => {
    if (url.includes('/api/token')) return opts.body.toString().includes('zly')
      ? { status: 400, body: { error: 'invalid_grant' } }
      : { body: { access_token: 'acc' } };
    return { body: { items: [item('2026-11-26T10:00:00Z', 'X')] } };
  });
  await syncAll(root, env);
  const idx = JSON.parse(await readFile(join(root, 'konta.json'), 'utf8'));
  assert.equal(idx.slots.length, 5);
  assert.deepEqual(idx.slots.map((s) => s.name), ['Osoba 1', null, 'Osoba 3', null, null]);
  assert.deepEqual(idx.slots[0].files, ['odsluchy/2026.json']);
  assert.equal(idx.slots[2].error, 'invalid_grant');
});

test('connectSlot zapisuje nazwę i konto; disconnectSlot usuwa', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  mockFetch((url) => url.includes('/api/token') ? { body: { access_token: 'a', refresh_token: 'r' } }
    : url.endsWith('/v1/me') ? { body: { display_name: 'kasia_123' } }
    : { body: { items: [] } });
  await connectSlot(root, { ...env, SPOTIFY_CODE: 'k', SPOTIFY_SLOT: '2' });
  let idx = JSON.parse(await readFile(join(root, 'konta.json'), 'utf8'));
  assert.equal(idx.slots[1].name, 'kasia_123');
  await connectSlot(root, { ...env, SPOTIFY_CODE: 'k', SPOTIFY_SLOT: '4', SPOTIFY_NAME: ' Tomek ' });
  idx = JSON.parse(await readFile(join(root, 'konta.json'), 'utf8'));
  assert.equal(idx.slots[3].name, 'Tomek');
  await disconnectSlot(root, { ...env, SPOTIFY_SLOT: '2' });
  idx = JSON.parse(await readFile(join(root, 'konta.json'), 'utf8'));
  assert.equal(idx.slots[1].name, null);
  assert.equal(await exists(join(root, 'konta/2')), false);
  await assert.rejects(() => connectSlot(root, { ...env, SPOTIFY_CODE: 'k', SPOTIFY_SLOT: '6' }), /od 1 do 5/);
});

test('pickImage wybiera najmniejsze zdjęcie ≥320 px (ostre na ekranach retina)', () => {
  assert.equal(pickImage([{ url: 'big', width: 640 }, { url: 'mid', width: 320 }, { url: 'small', width: 160 }]), 'mid');
  assert.equal(pickImage([{ url: 'big', width: 640 }, { url: 'small', width: 160 }, { url: 'tiny', width: 64 }]), 'big');
  assert.equal(pickImage([{ url: 'tiny', width: 64 }]), 'tiny');
  assert.equal(pickImage([]), null);
});

test('updateArtistImages: dokładne dopasowanie, pamięta braki, nie pyta drugi raz', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  const calls = mockFetch((url) => ({ body: { artists: { items: url.includes('sanah')
    ? [{ name: 'Sanah', images: [{ url: 'https://i/sanah', width: 320 }] }]
    : [{ name: 'Ktoś inny', images: [{ url: 'x', width: 320 }] }] } } }));
  const r = await updateArtistImages(root, 'acc', ['sanah', 'Nieznany', 'sanah']);
  assert.deepEqual(r, { checked: 2, found: 1 });
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer acc');
  const known = JSON.parse(await readFile(join(root, 'wykonawcy.json'), 'utf8'));
  assert.equal(known.sanah.img, 'https://i/sanah');
  assert.equal(known['nieznany'].img, null);
  const again = await updateArtistImages(root, 'acc', ['sanah', 'Nieznany']);
  assert.equal(again.checked, 0);
});

test('updateAlbumCovers: dokładna nazwa albumu, brak zapamiętany, bez powtórek', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  const calls = mockFetch((url) => ({ body: { albums: { items: url.includes('Dobry') || url.includes('dobry')
    ? [{ name: 'Inny', images: [{ url: 'zly', width: 300 }] }, { name: 'Dobry Album', images: [{ url: 'https://i/cover', width: 300 }, { url: 'https://i/small', width: 64 }] }]
    : [] } } }));
  const pairs = [{ artist: 'Ala', album: 'Dobry Album' }, { artist: 'Ala', album: 'Dobry Album' }, { artist: 'Ola', album: 'Brak' }];
  assert.deepEqual(await updateAlbumCovers(root, 'acc', pairs), { checked: 2, found: 1 });
  assert.match(calls[0].url, /type=album/);
  const known = JSON.parse(await readFile(join(root, 'okladki.json'), 'utf8'));
  assert.equal(known[coverKey('Ala', 'Dobry Album')].img, 'https://i/cover');
  assert.equal(known[coverKey('Ola', 'Brak')].img, null);
  assert.equal((await updateAlbumCovers(root, 'acc', pairs)).checked, 0);
});

test('recordFreshImages: okładki z utworów i zdjęcia wykonawców po id (dokładnie)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ss-'));
  const items = [{
    played_at: '2026-11-26T10:00:00Z',
    track: { name: 'S', artists: [{ id: 'id1', name: 'Eden' }], album: { name: 'LP', images: [{ url: 'https://i/c640', width: 640 }, { url: 'https://i/c300', width: 300 }, { url: 'https://i/c64', width: 64 }] } }
  }];
  const calls = mockFetch((url) => ({ body: { artists: [{ id: 'id1', name: 'Eden', images: [{ url: 'https://i/a640', width: 640 }, { url: 'https://i/a320', width: 320 }, { url: 'https://i/a160', width: 160 }] }] } }));
  const r = await recordFreshImages(root, 'acc', items);
  assert.deepEqual(r, { newCovers: 1, newArtists: 1 });
  assert.match(calls[0].url, /\/v1\/artists\?ids=id1$/);
  const covers = JSON.parse(await readFile(join(root, 'okladki.json'), 'utf8'));
  assert.equal(covers[coverKey('Eden', 'LP')].img, 'https://i/c300');
  const art = JSON.parse(await readFile(join(root, 'wykonawcy.json'), 'utf8'));
  assert.equal(art.eden.img, 'https://i/a320');
  assert.equal((await recordFreshImages(root, 'acc', items)).newArtists, 0); // już dokładne — bez ponownego pytania
});

test('szyfrowanie: z hasłem pliki są zaszyfrowane, jawne dane zostają zaszyfrowane, złe hasło — błąd', async () => {
  const { initCrypto, encryptAll, resetCrypto } = await import('./spotify-sync.mjs');
  const { createRequire } = await import('node:module');
  const C = createRequire(import.meta.url)('../crypt.js');
  const root = await mkdtemp(join(tmpdir(), 'ss-enc-'));
  const { config } = await C.createConfig('psina', { iter: 1000 });
  const cfgPath = join(root, 'szyfr-test.json');
  await writeFile(cfgPath, JSON.stringify(config));
  const data = join(root, 'dane');
  await mkdir(join(data, 'konta', '1', 'odsluchy'), { recursive: true });
  await writeFile(join(data, 'konta', '1', 'odsluchy', '2026.json'), JSON.stringify([{ ts: '2026-01-01T00:00:00Z', master_metadata_track_name: 'Jawne' }]));
  await writeFile(join(data, 'wykonawcy.json'), JSON.stringify({ sanah: { name: 'Sanah' } }));

  await assert.rejects(initCrypto({ SPOTISTATS_HASLO: 'zle' }, cfgPath), /nie pasuje/);
  assert.equal((await initCrypto({}, cfgPath)).mode, 'bez-hasla');
  assert.equal(await encryptAll(data), 0, 'bez hasła nic nie szyfruje');

  assert.equal((await initCrypto({ SPOTISTATS_HASLO: 'psina' }, cfgPath)).mode, 'szyfrowane');
  assert.equal(await encryptAll(data), 2);
  assert.equal(await encryptAll(data), 0, 'drugi raz nic');
  const raw = await readFile(join(data, 'konta', '1', 'odsluchy', '2026.json'), 'utf8');
  assert.ok(!raw.includes('Jawne'));
  const key = await C.unlock('psina', config);
  assert.equal((await C.readParsed(JSON.parse(raw), key))[0].master_metadata_track_name, 'Jawne');

  // Synchronizacja dopisuje do zaszyfrowanego pliku (czyta i zapisuje z kluczem).
  const dir = join(data, 'konta', '1');
  await writeFile(join(dir, 'token.json'), JSON.stringify(encryptToken('r', 'sekret')));
  mockFetch((url) => url.includes('/token') ? { body: { access_token: 'a' } } : { body: { items: [item('2026-11-26T17:00:00Z', 'Nowe')] } });
  await sync(dir, env);
  const rows = await C.readParsed(JSON.parse(await readFile(join(dir, 'odsluchy', '2026.json'), 'utf8')), key);
  assert.deepEqual(rows.map((r) => r.master_metadata_track_name), ['Jawne', 'Nowe']);
  assert.ok(C.isBox(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'))));

  // Bez hasła zaszyfrowanego pliku nie da się po cichu nadpisać.
  resetCrypto();
  await assert.rejects(sync(dir, env), (e) => e.code === 'locked');
  const still = await C.readParsed(JSON.parse(await readFile(join(dir, 'odsluchy', '2026.json'), 'utf8')), key);
  assert.equal(still.length, 2);
});
