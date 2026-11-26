// Uruchom: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./cloud.js');

const rows = [
  { t: Date.UTC(2023, 11, 31, 23, 0, 5), artist: 'A', track: 'x', album: 'LP', uri: 'u', ms: 200000 },
  { t: Date.UTC(2024, 0, 1, 0, 0, 5), artist: 'B', track: 'y', album: '', uri: 'u2', ms: 31000 },
  { t: Date.UTC(2024, 0, 2, 9, 0, 0), artist: 'A', track: 'x', album: 'LP', uri: 'u', ms: 180000 }
];

test('encode/decode: rok po UTC, słowniki, bez straty (poza uri)', () => {
  const enc = C.encodeRows(rows);
  assert.deepEqual(Object.keys(enc), ['2023', '2024']);
  assert.deepEqual(enc[2024].a, ['B', 'A']);
  assert.equal(enc[2024].r.length, 2);
  const back = C.decodeRows([enc[2024], enc[2023]]);
  assert.deepEqual(back.map((r) => [r.t, r.artist, r.track, r.album, r.ms]), rows.map((r) => [r.t, r.artist, r.track, r.album, r.ms]));
});

test('upload: wysyła lata, spis na końcu, usuwa stare lata, ponawia przy konflikcie', async () => {
  const store = new Map([['konta/2/eksport.json', { sha: 's0', text: JSON.stringify({ files: ['eksport/2019.json', 'eksport/2023.json'] }) }], ['konta/2/eksport/2019.json', { sha: 's1', text: '{}' }]]);
  const log = [];
  let conflicted = false;
  globalThis.fetch = async (url, opts) => {
    const path = decodeURIComponent(String(url).split('/contents/')[1].split('?')[0]);
    const method = opts.method;
    log.push(`${method} ${path}`);
    if (method === 'GET') {
      const f = store.get(path);
      return f ? { ok: true, status: 200, json: async () => ({ sha: f.sha, content: Buffer.from(f.text).toString('base64') }) } : { ok: false, status: 404 };
    }
    const body = JSON.parse(opts.body);
    if (method === 'PUT') {
      if (path === 'konta/2/eksport/2023.json' && !conflicted) { conflicted = true; return { ok: false, status: 409 }; }
      assert.equal(body.branch, 'dane');
      store.set(path, { sha: 'n', text: Buffer.from(body.content, 'base64').toString('utf8') });
      return { ok: true, status: 200 };
    }
    store.delete(path);
    return { ok: true, status: 200 };
  };
  const m = await C.upload({ token: 't', repo: 'o/r', slot: 2, rows, meta: { importedAt: 123, name: 'Kasia' } });
  assert.deepEqual(m.files, ['eksport/2023.json', 'eksport/2024.json']);
  assert.equal(JSON.parse(store.get('konta/2/eksport.json').text).name, 'Kasia');
  assert.equal(JSON.parse(store.get('konta/2/eksport.json').text).importedAt, 123);
  assert.equal(store.has('konta/2/eksport/2019.json'), false); // stary rok usunięty
  assert.ok(log.filter((l) => l.startsWith('PUT')).at(-1).endsWith('eksport.json')); // spis zapisany jako ostatni
  assert.ok(conflicted);
});

test('upload: zły token daje czytelny błąd', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => C.upload({ token: 'x', repo: 'o/r', slot: 1, rows }), /nie przyjął tokenu/);
});
