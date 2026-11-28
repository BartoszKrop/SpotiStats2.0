/*
 * SpotiStats — szyfrowanie danych hasłem (to samo w przeglądarce i w GitHub Actions).
 *
 * szyfr.json (w repo, publiczny): sól i liczba iteracji PBKDF2 oraz zaszyfrowany „sprawdzacz”,
 * którym weryfikujemy hasło. Samego hasła nie ma nigdzie w repo.
 * Klucz = PBKDF2-SHA256(hasło, sól) → AES-256-GCM. Każdy plik z danymi na gałęzi „dane” to
 *   { "szyfr": 1, "iv": "<base64>", "d": "<base64: AES-GCM(gzip(JSON))>" }
 * Pliki bez pola „szyfr” są czytane jak dawniej (jawne, sprzed włączenia szyfrowania).
 */
(function (root) {
  'use strict';

  const subtle = () => {
    const c = root.crypto && root.crypto.subtle;
    if (!c) throw new Error('Ta przeglądarka nie obsługuje szyfrowania (WebCrypto). Otwórz stronę przez https.');
    return c;
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const CHECK_TEXT = 'spotistats';

  function toB64(bytes) {
    const u = new Uint8Array(bytes);
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromB64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  async function pipe(bytes, stream) {
    if (typeof root.CompressionStream !== 'function') throw new Error('Brak CompressionStream');
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }
  const gzip = (bytes) => pipe(bytes, new root.CompressionStream('gzip'));
  const gunzip = (bytes) => pipe(bytes, new root.DecompressionStream('gzip'));

  const isBox = (x) => Boolean(x) && typeof x === 'object' && x.szyfr === 1 && typeof x.d === 'string';

  /** Hasło + konfiguracja → klucz AES (wyciągalny, żeby dało się go zapamiętać w przeglądarce). */
  async function deriveKey(password, config) {
    const base = await subtle().importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(config.salt), iterations: config.iter },
      base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(bytes, key, { compress = true } = {}) {
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const data = compress ? await gzip(bytes) : bytes;
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, data);
    return { szyfr: 1, ...(compress ? { z: 1 } : {}), iv: toB64(iv), d: toB64(ct) };
  }

  async function decryptBytes(box, key) {
    let pt;
    try {
      pt = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.d)));
    } catch {
      throw new Error('Nie da się odszyfrować danych — złe hasło albo zmienione dane.');
    }
    return box.z ? gunzip(pt) : pt;
  }

  /** Tekst (zwykle JSON) → obiekt-pudełko do zapisania jako JSON. */
  const seal = async (text, key) => encryptBytes(enc.encode(text), key);
  /** Obiekt-pudełko → tekst. */
  const open = async (box, key) => dec.decode(await decryptBytes(box, key));

  /** Odczyt pliku: jawny JSON zwraca od razu, zaszyfrowany odszyfrowuje (bez klucza — błąd). */
  async function readParsed(parsed, key) {
    if (!isBox(parsed)) return parsed;
    if (!key) {
      const err = new Error('Dane są zaszyfrowane, a nie podano hasła.');
      err.code = 'locked';
      throw err;
    }
    return JSON.parse(await open(parsed, key));
  }

  /** Sprawdza hasło z konfiguracją. Zwraca klucz albo null (złe hasło). */
  async function unlock(password, config) {
    const key = await deriveKey(password, config);
    return (await verify(key, config)) ? key : null;
  }

  async function verify(key, config) {
    try { return (await open(config.check, key)) === CHECK_TEXT; } catch { return false; }
  }

  /** Nowa konfiguracja dla hasła (sól losowa). Zwraca { config, key }. */
  async function createConfig(password, { iter = 600000, hint = '' } = {}) {
    const salt = toB64(root.crypto.getRandomValues(new Uint8Array(16)));
    const config = { v: 1, iter, salt, hint };
    const key = await deriveKey(password, config);
    config.check = await encryptBytes(enc.encode(CHECK_TEXT), key, { compress: false });
    return { config, key };
  }

  const exportKey = async (key) => toB64(await subtle().exportKey('raw', key));
  const importKey = (b64) => subtle().importKey('raw', fromB64(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

  const API = { isBox, deriveKey, seal, open, readParsed, unlock, verify, createConfig, exportKey, importKey, toB64, fromB64 };
  if (typeof module === 'object' && module.exports) module.exports = API;
  else root.SpotiCrypt = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
