/**
 * SpotiStats 2.0 — App logic
 *
 * Responsibilities:
 *   • Local auth  — username + hashed password stored in localStorage
 *   • Session     — sessionStorage (+ optional localStorage "remember me")
 *   • Data store  — IndexedDB (listening entries persist between sessions)
 *   • ZIP import  — JSZip library reads Spotify data packages
 *   • Dashboard   — renders stats returned by analytics.js
 */

import {
  buildStats,
  filterByRange,
  normalizeHistoryRowsWithReport,
  parseGenreMap
} from './analytics.js';

// ──────────────────────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────────────────────
const USERS_KEY      = 'ss_users';       // localStorage: user registry
const SESSION_KEY    = 'ss_session';     // sessionStorage: active user
const REMEMBER_KEY   = 'ss_remember';   // localStorage: remembered user
const IDB_NAME       = 'SpotiStats';
const IDB_VERSION    = 1;
const IDB_STORE      = 'userData';
const MIN_BAR_PCT    = 3;               // minimum bar width %

// ──────────────────────────────────────────────────────────────
// CRYPTO — SHA-256 via SubtleCrypto; fallback for file:// on Firefox
// ──────────────────────────────────────────────────────────────
async function hashPassword(raw) {
  // crypto.subtle is available in all modern browsers; falls back only when
  // SubtleCrypto is blocked (e.g. Firefox on file:// without a local server).
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(raw)
    );
    return [...new Uint8Array(buf)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback: two-lane FNV-1a (32-bit) for local-only user separation when
  // SubtleCrypto is unavailable.  Not cryptographically strong — serve via
  // localhost so SubtleCrypto is always available for stronger hashing.
  // FNV-1a 32-bit offset basis / second-lane seed:
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xc4ceb9fe >>> 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = (Math.imul(h1 ^ c, 0x01000193)) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x01000193)) >>> 0;
  }
  return 'fb_' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ──────────────────────────────────────────────────────────────
// AUTH
// ──────────────────────────────────────────────────────────────
function getUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY) || '{}'); }
  catch { return {}; }
}
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

async function registerUser(username, password) {
  const key = username.trim().toLowerCase();
  if (!key)          return { ok: false, error: 'Username is required.' };
  if (key.length < 2) return { ok: false, error: 'Username must be at least 2 characters.' };
  if (!password)     return { ok: false, error: 'Password is required.' };
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };

  const users = getUsers();
  if (users[key])    return { ok: false, error: 'That username is already taken.' };

  const hash = await hashPassword(key + ':' + password);
  users[key] = { hash, displayName: username.trim(), createdAt: Date.now() };
  saveUsers(users);
  return { ok: true, username: key };
}

async function loginUser(username, password) {
  const key  = username.trim().toLowerCase();
  const users = getUsers();
  const user  = users[key];
  if (!user) return { ok: false, error: 'Unknown username.' };
  const hash = await hashPassword(key + ':' + password);
  if (hash !== user.hash) return { ok: false, error: 'Wrong password.' };
  return { ok: true, username: key, displayName: user.displayName };
}

function getSession() {
  return (
    sessionStorage.getItem(SESSION_KEY) ||
    localStorage.getItem(REMEMBER_KEY)  ||
    null
  );
}

function setSession(username, remember) {
  sessionStorage.setItem(SESSION_KEY, username);
  if (remember) localStorage.setItem(REMEMBER_KEY, username);
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(REMEMBER_KEY);
}

// ──────────────────────────────────────────────────────────────
// INDEXEDDB STORAGE
// ──────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'username' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveUserData(username, payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readwrite');
    const rec = { username, ...payload, savedAt: Date.now() };
    tx.objectStore(IDB_STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadUserData(username) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(username);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function clearUserData(username) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(username);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ──────────────────────────────────────────────────────────────
// FILE IMPORT — handles .zip and .json
// ──────────────────────────────────────────────────────────────
async function importFiles(fileList) {
  const files     = [...fileList];
  const rawRows   = [];
  const fileErrors = [];

  for (const file of files) {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'zip') {
      if (typeof JSZip === 'undefined') {
        fileErrors.push(`${file.name}: ZIP support unavailable (jszip.min.js not loaded)`);
        continue;
      }
      try {
        const zip      = await JSZip.loadAsync(file);
        const jsonFiles = Object.values(zip.files).filter(
          f => !f.dir && f.name.toLowerCase().endsWith('.json')
        );
        for (const zf of jsonFiles) {
          try {
            const text   = await zf.async('text');
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) rawRows.push(...parsed);
            else fileErrors.push(`${zf.name}: root value must be an array`);
          } catch {
            fileErrors.push(`${zf.name}: invalid JSON`);
          }
        }
      } catch {
        fileErrors.push(`${file.name}: could not read ZIP archive`);
      }
    } else {
      try {
        const text   = await file.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) rawRows.push(...parsed);
        else fileErrors.push(`${file.name}: root value must be an array`);
      } catch {
        fileErrors.push(`${file.name}: invalid JSON`);
      }
    }
  }

  const report = normalizeHistoryRowsWithReport(rawRows);
  return {
    rows:       report.rows,
    invalidRows: report.invalidRows,
    totalRows:  report.totalRows,
    fileErrors
  };
}

// ──────────────────────────────────────────────────────────────
// RENDER HELPERS
// ──────────────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

function renderBarList(items) {
  if (!items.length) return '<p class="no-data">No data in this range.</p>';
  const maxH = Math.max(...items.map(i => i.hours), 0);
  return `<ul class="bar-list">${items.map((item, idx) => {
    const pct = maxH > 0 ? Math.max((item.hours / maxH) * 100, MIN_BAR_PCT) : 0;
    return `
      <li class="bar-item">
        <div class="bar-top">
          <span class="bar-rank">${idx + 1}</span>
          <span class="bar-name" title="${esc(item.label)}">${esc(item.label)}</span>
          <span class="bar-meta">${item.hours}h · ${item.plays}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%"></div>
        </div>
      </li>`;
  }).join('')}</ul>`;
}

function renderPatternChart(rows, labelFn) {
  if (!rows.length) return '<p class="no-data">No data.</p>';
  const maxH = Math.max(...rows.map(r => r.hours), 0.001);
  return `<div class="pattern-chart">${rows.map(row => {
    const pct   = Math.max((row.hours / maxH) * 90, row.hours > 0 ? 4 : 0);
    const label = labelFn(row);
    return `
      <div class="pattern-col" title="${esc(label)}: ${row.hours}h">
        <div class="pattern-bar" style="height:${pct}%"></div>
        <div class="pattern-lbl">${esc(label)}</div>
      </div>`;
  }).join('')}</div>`;
}

// ──────────────────────────────────────────────────────────────
// APP STATE
// ──────────────────────────────────────────────────────────────
let currentUser  = null;          // { username, displayName }
let entries      = [];            // normalised history rows
let genreMap     = new Map();
let rangeCache   = new Map();
let currentRange = 'all';
let dataInfo     = '';

// ──────────────────────────────────────────────────────────────
// DASHBOARD RENDER
// ──────────────────────────────────────────────────────────────
const WEEKDAY_SHORT = {
  Sunday:    'Sun', Monday:  'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday:  'Thu', Friday: 'Fri', Saturday: 'Sat'
};

function getStats() {
  if (!rangeCache.has(currentRange)) {
    rangeCache.set(
      currentRange,
      buildStats(filterByRange(entries, currentRange), genreMap)
    );
  }
  return rangeCache.get(currentRange);
}

function renderDashboard() {
  const s = getStats();

  // KPI
  document.getElementById('kpi-row').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Total plays</div>
      <div class="kpi-value">${s.summary.totalPlays.toLocaleString()}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Hours listened</div>
      <div class="kpi-value">${s.summary.totalHours.toLocaleString()}</div>
      <div class="kpi-sub">hours total</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Daily average</div>
      <div class="kpi-value">${s.summary.avgDailyMinutes}</div>
      <div class="kpi-sub">minutes / day</div>
    </div>
  `;

  // Top lists
  document.getElementById('tops-grid').innerHTML = `
    <div class="card">
      <div class="card-title">Top Artists</div>
      ${renderBarList(s.topArtists)}
    </div>
    <div class="card">
      <div class="card-title">Top Tracks</div>
      ${renderBarList(s.topTracks)}
    </div>
    <div class="card">
      <div class="card-title">Top Albums</div>
      ${renderBarList(s.topAlbums)}
    </div>
    <div class="card">
      <div class="card-title">Top Genres</div>
      ${renderBarList(s.topGenres)}
    </div>
  `;

  // Activity patterns
  document.getElementById('patterns-grid').innerHTML = `
    <div class="card">
      <div class="card-title">Activity by weekday</div>
      ${renderPatternChart(s.weekdayHours, row => WEEKDAY_SHORT[row.day] || row.day)}
    </div>
    <div class="card">
      <div class="card-title">Activity by hour of day</div>
      ${renderPatternChart(s.hourlyHours, row => String(row.hour).padStart(2, '0'))}
    </div>
  `;

  document.getElementById('data-info').textContent = dataInfo;
}

// ──────────────────────────────────────────────────────────────
// SCREEN TRANSITIONS
// ──────────────────────────────────────────────────────────────
function showAuth() {
  document.getElementById('screen-auth').classList.remove('hidden');
  document.getElementById('screen-app').classList.add('hidden');
}

function showApp() {
  document.getElementById('screen-auth').classList.add('hidden');
  document.getElementById('screen-app').classList.remove('hidden');
  document.getElementById('topbar-username').textContent =
    currentUser.displayName || currentUser.username;
  refreshAppState();
}

function refreshAppState() {
  const hasData   = entries.length > 0;
  const emptyEl   = document.getElementById('state-empty');
  const dataEl    = document.getElementById('state-data');
  emptyEl.classList.toggle('hidden', hasData);
  dataEl.classList.toggle('hidden', !hasData);
  if (hasData) renderDashboard();
}

// ──────────────────────────────────────────────────────────────
// IMPORT HANDLER
// ──────────────────────────────────────────────────────────────
async function handleImport(fileList, statusEl) {
  if (!fileList || fileList.length === 0) return;
  if (statusEl) statusEl.textContent = 'Reading files…';

  try {
    const result = await importFiles(fileList);
    entries      = result.rows;
    genreMap     = new Map();
    rangeCache   = new Map();

    const parts = [`${entries.length.toLocaleString()} listening events`];
    if (result.invalidRows > 0) parts.push(`${result.invalidRows} rows skipped`);
    if (result.fileErrors.length > 0) parts.push(`${result.fileErrors.length} file error(s)`);
    dataInfo = `${parts.join(' · ')} · Imported ${new Date().toLocaleDateString()}`;

    if (statusEl) statusEl.textContent = dataInfo;

    // Persist to IndexedDB
    await saveUserData(currentUser.username, { entries, dataInfo });

    refreshAppState();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  }
}

// ──────────────────────────────────────────────────────────────
// DEMO DATA
// ──────────────────────────────────────────────────────────────
const DEMO_ARTISTS = [
  { artist: 'Daft Punk',      track: 'Get Lucky',               album: 'Random Access Memories' },
  { artist: 'The Weeknd',     track: 'Blinding Lights',          album: 'After Hours'            },
  { artist: 'Tame Impala',    track: 'The Less I Know The Better', album: 'Currents'             },
  { artist: 'Dua Lipa',       track: 'Levitating',               album: 'Future Nostalgia'       },
  { artist: 'Arctic Monkeys', track: 'Do I Wanna Know?',         album: 'AM'                     }
];
const DEMO_GENRES = new Map([
  ['Daft Punk',      ['electronic', 'french house']],
  ['The Weeknd',     ['r&b', 'pop']],
  ['Tame Impala',    ['psychedelic rock', 'indie']],
  ['Dua Lipa',       ['pop', 'dance pop']],
  ['Arctic Monkeys', ['indie rock', 'alternative']]
]);

function createDemoEntries() {
  const now  = new Date();
  const rows = [];
  for (let day = 0; day < 120; day++) {
    for (let s = 0; s < (day % 3) + 1; s++) {
      const pick = DEMO_ARTISTS[(day + s) % DEMO_ARTISTS.length];
      const ts   = new Date(
        now.getTime() - day * 86_400_000 + (8 + ((day + s) % 14)) * 3_600_000
      );
      rows.push({
        timestamp: ts.toISOString(),
        artist:    pick.artist,
        track:     pick.track,
        album:     pick.album,
        msPlayed:  120_000 + ((day * 17 + s * 23) % 200_000)
      });
    }
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────
// INITIALISATION
// ──────────────────────────────────────────────────────────────
async function init() {
  const saved = getSession();
  if (saved) {
    const users = getUsers();
    const user  = users[saved];
    if (user) {
      currentUser = { username: saved, displayName: user.displayName };
      try {
        const stored = await loadUserData(saved);
        if (stored?.entries?.length) {
          entries  = stored.entries;
          dataInfo = stored.dataInfo || `${entries.length.toLocaleString()} events loaded`;
        }
      } catch { /* IndexedDB unavailable — start fresh */ }
      showApp();
      return;
    }
  }
  showAuth();
}

// ──────────────────────────────────────────────────────────────
// EVENT WIRING
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await init();

  /* ── Auth tab switcher ─── */
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => {
        t.classList.toggle('auth-tab--active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      const target = tab.dataset.tab;
      document.getElementById('form-login').classList.toggle('hidden',    target !== 'login');
      document.getElementById('form-register').classList.toggle('hidden', target !== 'register');
    });
  });

  /* ── Login ─── */
  document.getElementById('form-login').addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const remember = document.getElementById('login-remember').checked;
    const errEl    = document.getElementById('login-error');

    const result = await loginUser(username, password);
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    setSession(result.username, remember);
    currentUser = { username: result.username, displayName: result.displayName };

    try {
      const stored = await loadUserData(result.username);
      if (stored?.entries?.length) {
        entries  = stored.entries;
        dataInfo = stored.dataInfo || `${entries.length.toLocaleString()} events loaded`;
      }
    } catch { /* ignore */ }

    showApp();
  });

  /* ── Register ─── */
  document.getElementById('form-register').addEventListener('submit', async e => {
    e.preventDefault();
    const username  = document.getElementById('reg-username').value;
    const password  = document.getElementById('reg-password').value;
    const password2 = document.getElementById('reg-password2').value;
    const errEl     = document.getElementById('reg-error');

    if (password !== password2) {
      errEl.textContent = 'Passwords do not match.';
      errEl.classList.remove('hidden');
      return;
    }

    const result = await registerUser(username, password);
    if (!result.ok) {
      errEl.textContent = result.error;
      errEl.classList.remove('hidden');
      return;
    }
    errEl.classList.add('hidden');
    setSession(result.username, false);
    const users = getUsers();
    currentUser = { username: result.username, displayName: users[result.username].displayName };
    entries = [];
    showApp();
  });

  /* ── Logout ─── */
  document.getElementById('btn-logout').addEventListener('click', () => {
    clearSession();
    currentUser = null;
    entries     = [];
    genreMap    = new Map();
    rangeCache  = new Map();
    showAuth();
  });

  /* ── Import (empty state drop zone) ─── */
  const dropZone     = document.getElementById('drop-zone');
  const importInput  = document.getElementById('import-files');
  const importStatus = document.getElementById('import-status');

  importInput.addEventListener('change', e => handleImport(e.target.files, importStatus));

  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop',      e  => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleImport(e.dataTransfer.files, importStatus);
  });
  dropZone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); importInput.click(); }
  });

  /* ── Reimport (dashboard toolbar) ─── */
  document.getElementById('reimport-files').addEventListener('change', e =>
    handleImport(e.target.files, document.getElementById('import-status'))
  );

  /* ── Clear data ─── */
  document.getElementById('btn-clear-data').addEventListener('click', async () => {
    if (!confirm('Delete all your saved listening data? This cannot be undone.')) return;
    await clearUserData(currentUser.username);
    entries    = [];
    genreMap   = new Map();
    rangeCache = new Map();
    dataInfo   = '';
    refreshAppState();
  });

  /* ── Range pills ─── */
  document.getElementById('range-pills').addEventListener('click', e => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    document.querySelectorAll('.pill').forEach(p =>
      p.classList.toggle('pill--active', p === pill)
    );
    currentRange = pill.dataset.range;
    renderDashboard();
  });

  /* ── Load demo data ─── */
  document.getElementById('btn-load-demo').addEventListener('click', async () => {
    entries    = createDemoEntries();
    genreMap   = DEMO_GENRES;
    rangeCache = new Map();
    dataInfo   = `${entries.length} demo listening events loaded`;
    await saveUserData(currentUser.username, { entries, dataInfo });
    refreshAppState();
  });
});

