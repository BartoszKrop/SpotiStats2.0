// Uruchom: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptToken, decryptToken, itemToRow, mergeRows, redirectUri, connect, sync } from './spotify-sync.mjs';

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
