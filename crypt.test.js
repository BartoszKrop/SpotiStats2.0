// Uruchom: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('./crypt.js');
const Cloud = require('./cloud.js');

const fast = { iter: 1000, hint: 'podpowiedź' };

test('hasło: dobre odblokowuje, złe nie', async () => {
  const { config } = await C.createConfig('psina', fast);
  assert.equal(config.hint, 'podpowiedź');
  assert.ok(!JSON.stringify(config).includes('psina'));
  assert.ok(await C.unlock('psina', config));
  assert.equal(await C.unlock('Psina', config), null);
});

test('seal/open: dane nieczytelne bez klucza, zgadzają się po odszyfrowaniu', async () => {
  const { config, key } = await C.createConfig('psina', fast);
  const data = { a: ['Kwiat Jabłoni', 'Sanah'], r: Array.from({ length: 500 }, (_, i) => [i, i * 2]) };
  const box = await C.seal(JSON.stringify(data), key);
  assert.ok(C.isBox(box));
  assert.ok(!JSON.stringify(box).includes('Sanah'));
  assert.ok(JSON.stringify(box).length < JSON.stringify(data).length, 'kompresja');
  assert.deepEqual(await C.readParsed(box, key), data);
  const other = await C.unlock('psina', config);
  assert.deepEqual(await C.readParsed(box, other), data, 'klucz z hasła = ten sam klucz');
  await assert.rejects(C.readParsed(box, null), (e) => e.code === 'locked');
  const { key: wrong } = await C.createConfig('inne', fast);
  await assert.rejects(C.readParsed(box, wrong));
});

test('jawne pliki czytają się jak dawniej', async () => {
  assert.deepEqual(await C.readParsed([1, 2], null), [1, 2]);
  assert.equal(await C.readParsed(null, null), null);
});

test('klucz da się zapamiętać i odtworzyć', async () => {
  const { config, key } = await C.createConfig('psina', fast);
  const back = await C.importKey(await C.exportKey(key));
  assert.ok(await C.verify(back, config));
});

test('szyfr.json w repo: poprawny format, bez hasła w środku', async () => {
  const config = require('./szyfr.json');
  assert.equal(config.v, 1);
  assert.ok(config.iter >= 100000);
  assert.ok(C.isBox(config.check));
  assert.ok(config.hint);
});

test('zapis na GitHuba z kluczem idzie zaszyfrowany', async () => {
  const { key } = await C.createConfig('psina', fast);
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method === 'PUT') sent.push(JSON.parse(opts.body));
    return { ok: opts.method !== 'GET', status: opts.method === 'GET' ? 404 : 200, json: async () => ({}) };
  };
  try {
    await Cloud.saveProfile({ token: 't', repo: 'a/b', slot: 1, profile: { name: 'Bartek' }, key });
  } finally { globalThis.fetch = realFetch; }
  const text = Buffer.from(sent[0].content, 'base64').toString('utf8');
  assert.ok(!text.includes('Bartek'));
  assert.deepEqual(await C.readParsed(JSON.parse(text), key), { name: 'Bartek' });
});
