// Uruchom: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const Art = require('./art.js');

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test('pickArtist: dokładna nazwa (bez diakrytyków/wielkości liter), odrzuca pusty obrazek', () => {
  const list = [{ name: 'Sanah Fan', picture_big: 'x' }, { name: 'SANAH', picture_big: 'https://c/artist/abc/500x500.jpg' }];
  assert.equal(Art.pickArtist(list, 'sanah'), 'https://c/artist/abc/500x500.jpg');
  assert.equal(Art.pickArtist([{ name: 'Beyoncé', picture_big: 'u' }], 'Beyonce'), 'u');
  assert.equal(Art.pickArtist([{ name: 'X', picture_big: 'https://c/images/artist//500x500-000000-80-0-0.jpg' }], 'X'), null);
  assert.equal(Art.pickArtist([], 'X'), null);
});

test('pickAlbum: tytuł + wykonawca, w ostateczności sam tytuł', () => {
  const list = [{ title: 'LP', artist: { name: 'Inny' }, cover_big: 'zly' }, { title: 'LP', artist: { name: 'Ala' }, cover_big: 'dobry' }];
  assert.equal(Art.pickAlbum(list, 'Ala', 'lp'), 'dobry');
  assert.equal(Art.pickAlbum([{ title: 'LP', artist: { name: 'Inny' }, cover_big: 'jedyny' }], 'Ala', 'LP'), 'jedyny');
});

test('loader: pobiera raz, zapamiętuje (też brak), po odświeżeniu nie pyta ponownie', async () => {
  const storage = mem();
  const calls = [];
  const fetchJson = async (url) => { calls.push(url); return { data: url.includes('Ala') ? [{ name: 'Ala', picture_big: 'https://c/artist/1/500.jpg' }] : [] }; };
  let changes = 0;
  const l = Art.createLoader({ storage, fetchJson, onChange: () => changes++, spacingMs: 0 });
  assert.equal(l.artist('Ala'), null); // jeszcze nie ma
  l.artist('Ala'); l.artist('Nikt'); // duplikat nie dubluje zapytania
  await l.whenIdle();
  l.flush();
  assert.equal(calls.length, 2);
  assert.equal(l.artist('Ala'), 'https://c/artist/1/500.jpg');
  assert.equal(l.artist('Nikt'), null);
  assert.ok(changes >= 1);
  const l2 = Art.createLoader({ storage, fetchJson, spacingMs: 0 });
  assert.equal(l2.artist('Ala'), 'https://c/artist/1/500.jpg');
  l2.artist('Nikt'); await l2.whenIdle();
  assert.equal(calls.length, 2); // brak też zapamiętany (ponowna próba dopiero po 14 dniach)
});

test('loader: błąd sieci nie zapisuje „braku”, kolejna próba możliwa', async () => {
  const storage = mem();
  let fail = true; let n = 0;
  const fetchJson = async () => { n++; if (fail) throw new Error('x'); return { data: [{ name: 'Ala', picture_big: 'u' }] }; };
  const l = Art.createLoader({ storage, fetchJson, spacingMs: 0 });
  l.artist('Ala'); await l.whenIdle();
  fail = false;
  l.artist('Ala'); await l.whenIdle();
  assert.equal(n, 2);
  assert.equal(l.artist('Ala'), 'u');
});
