import { buildStats, filterByRange, normalizeHistoryRowsWithReport, parseGenreMap } from './analytics.js';

const STORAGE_KEY = 'spotistats.local.store';
const SESSION_KEY = 'spotistats.local.session';
const STORAGE_VERSION = 1;
const MIN_TOP_BAR_WIDTH_PERCENT = 4;
const MIN_PATTERN_BAR_WIDTH_PERCENT = 2;

const DEMO_GENRE_MAP_OBJECT = {
  'Daft Punk': ['electronic', 'french house'],
  'The Weeknd': ['r&b', 'pop'],
  'Tame Impala': ['psychedelic rock', 'indie'],
  'Dua Lipa': ['pop', 'dance pop'],
  'Arctic Monkeys': ['indie rock', 'alternative']
};

const authScreen = document.getElementById('authScreen');
const dashboardScreen = document.getElementById('dashboardScreen');
const loginTabBtn = document.getElementById('loginTabBtn');
const registerTabBtn = document.getElementById('registerTabBtn');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginUsername = document.getElementById('loginUsername');
const loginPassword = document.getElementById('loginPassword');
const registerUsername = document.getElementById('registerUsername');
const registerPassword = document.getElementById('registerPassword');
const authStatus = document.getElementById('authStatus');

const historyInput = document.getElementById('historyFiles');
const genreInput = document.getElementById('genreFile');
const importBtn = document.getElementById('importBtn');
const rangeSelect = document.getElementById('timeRange');
const status = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const topsEl = document.getElementById('tops');
const patternsEl = document.getElementById('patterns');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const clearDataBtn = document.getElementById('clearDataBtn');
const logoutBtn = document.getElementById('logoutBtn');
const sessionInfo = document.getElementById('sessionInfo');
const sourceInfoEl = document.getElementById('sourceInfo');

let store = loadStore();
let currentUser = null;
let entries = [];
let genreMap = new Map();
let rangeCache = new Map();
let sourceState = {
  mode: 'none',
  files: [],
  totalRows: 0,
  loadedRows: 0,
  invalidRows: 0,
  fileErrors: 0,
  importedAt: null
};
let cachedZipModule = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function hideResults() {
  summaryEl.classList.add('hidden');
  topsEl.classList.add('hidden');
  patternsEl.classList.add('hidden');
}

function showAuthMessage(message, isError = false) {
  authStatus.textContent = message;
  authStatus.style.color = isError ? 'var(--danger)' : 'var(--accent-2)';
}

function showDashboardStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? 'var(--danger)' : 'var(--accent-2)';
}

function toBase64(uint8Array) {
  const chunkSize = 0x8000;
  const chunks = [];
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const slice = uint8Array.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

function fromBase64(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hashPassword(password, saltBase64) {
  const encoder = new TextEncoder();
  const salt = fromBase64(saltBase64);
  const data = new Uint8Array([...salt, ...encoder.encode(password)]);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toBase64(new Uint8Array(digest));
}

function loadStore() {
  const fallback = { version: STORAGE_VERSION, users: {} };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    return migrateStore(parsed);
  } catch {
    return fallback;
  }
}

function migrateStore(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { version: STORAGE_VERSION, users: {} };
  }

  if (parsed.version === STORAGE_VERSION && parsed.users && typeof parsed.users === 'object') {
    return parsed;
  }

  const users = parsed.users && typeof parsed.users === 'object' ? parsed.users : {};

  return {
    version: STORAGE_VERSION,
    users
  };
}

function persistStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function setSession(username) {
  localStorage.setItem(SESSION_KEY, username);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function getSessionUser() {
  return localStorage.getItem(SESSION_KEY);
}

function getCurrentUserRecord() {
  return currentUser ? store.users[currentUser] : null;
}

function ensureUserData(record) {
  if (!record.data || typeof record.data !== 'object') {
    record.data = { historyRows: [], genreRaw: null, sourceState: null };
  }

  if (!Array.isArray(record.data.historyRows)) {
    record.data.historyRows = [];
  }

  if (!record.settings || typeof record.settings !== 'object') {
    record.settings = { timeRange: 'all' };
  }

  if (!record.settings.timeRange) {
    record.settings.timeRange = 'all';
  }
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  loginTabBtn.classList.toggle('active', isLogin);
  registerTabBtn.classList.toggle('active', !isLogin);
  loginTabBtn.setAttribute('aria-selected', String(isLogin));
  registerTabBtn.setAttribute('aria-selected', String(!isLogin));
  loginForm.classList.toggle('hidden', !isLogin);
  registerForm.classList.toggle('hidden', isLogin);
}

function showAuthScreen() {
  authScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
}

function showDashboardScreen() {
  authScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
}

function list(items) {
  if (!items.length) return '<p>Brak danych w tym zakresie.</p>';
  const maxHours = Math.max(...items.map((item) => item.hours), 0);
  return `<ol class="bar-list">${items
    .map((item) => {
      const width =
        maxHours > 0 ? Math.max((item.hours / maxHours) * 100, MIN_TOP_BAR_WIDTH_PERCENT) : 0;
      return `<li class="bar-row">
          <div class="bar-label">${escapeHtml(item.label)}</div>
          <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
          <div class="bar-meta">${item.hours}h · ${item.plays} odtworzeń</div>
        </li>`;
    })
    .join('')}</ol>`;
}

function patternList(rows, labelBuilder) {
  if (!rows.length) return '<p>Brak danych w tym zakresie.</p>';
  const maxHours = Math.max(...rows.map((row) => row.hours), 0);
  return `<ul class="bar-list">${rows
    .map((row) => {
      const width =
        maxHours > 0
          ? Math.max((row.hours / maxHours) * 100, MIN_PATTERN_BAR_WIDTH_PERCENT)
          : 0;
      return `<li class="bar-row">
        <div class="bar-label">${escapeHtml(labelBuilder(row))}</div>
        <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
        <div class="bar-meta">${row.hours}h</div>
      </li>`;
    })
    .join('')}</ul>`;
}

function createDemoEntries() {
  const artists = [
    { artist: 'Daft Punk', track: 'Get Lucky', album: 'Random Access Memories' },
    { artist: 'The Weeknd', track: 'Blinding Lights', album: 'After Hours' },
    { artist: 'Tame Impala', track: 'The Less I Know The Better', album: 'Currents' },
    { artist: 'Dua Lipa', track: 'Levitating', album: 'Future Nostalgia' },
    { artist: 'Arctic Monkeys', track: 'Do I Wanna Know?', album: 'AM' }
  ];

  const now = new Date();
  const demo = [];

  for (let day = 0; day < 120; day += 1) {
    const sessions = (day % 3) + 1;
    for (let session = 0; session < sessions; session += 1) {
      const pick = artists[(day + session) % artists.length];
      const timestamp = new Date(
        now.getTime() - day * 24 * 60 * 60 * 1000 +
          (8 + ((day + session) % 14)) * 60 * 60 * 1000
      );

      demo.push({
        timestamp: timestamp.toISOString(),
        artist: pick.artist,
        track: pick.track,
        album: pick.album,
        msPlayed: 120_000 + ((day * 17 + session * 23) % 200_000)
      });
    }
  }

  return demo;
}

function renderSourceInfo() {
  const sourceLabelMap = {
    none: 'Brak danych',
    local: 'Lokalny zapis',
    import: 'Import ręczny',
    demo: 'Dane demo'
  };

  const importedAtText = sourceState.importedAt
    ? new Date(sourceState.importedAt).toLocaleString()
    : '—';

  sourceInfoEl.innerHTML = `
    <article class="data-pill"><span>Źródło</span><strong>${escapeHtml(sourceLabelMap[sourceState.mode] || sourceState.mode)}</strong></article>
    <article class="data-pill"><span>Rekordy po normalizacji</span><strong>${sourceState.loadedRows}</strong></article>
    <article class="data-pill"><span>Wiersze wejściowe</span><strong>${sourceState.totalRows}</strong></article>
    <article class="data-pill"><span>Pominięte wpisy</span><strong>${sourceState.invalidRows}</strong></article>
    <article class="data-pill"><span>Błędy plików/parsingu</span><strong>${sourceState.fileErrors}</strong></article>
    <article class="data-pill"><span>Ostatni import</span><strong>${escapeHtml(importedAtText)}</strong></article>
  `;
}

function render() {
  const selectedRange = rangeSelect.value;
  if (!rangeCache.has(selectedRange)) {
    const filtered = filterByRange(entries, selectedRange);
    rangeCache.set(selectedRange, buildStats(filtered, genreMap));
  }

  const stats = rangeCache.get(selectedRange);

  summaryEl.innerHTML = `
    <h3>Podsumowanie (${escapeHtml(selectedRange)})</h3>
    <div class="kpi-grid">
      <article class="kpi"><span>Łączne odtworzenia</span><strong>${stats.summary.totalPlays}</strong></article>
      <article class="kpi"><span>Łączny czas słuchania</span><strong>${stats.summary.totalHours}h</strong></article>
      <article class="kpi"><span>Średnio dziennie</span><strong>${stats.summary.avgDailyMinutes} min</strong></article>
    </div>
  `;

  topsEl.innerHTML = `
    <article class="card"><h3>Top artyści</h3>${list(stats.topArtists)}</article>
    <article class="card"><h3>Top utwory</h3>${list(stats.topTracks)}</article>
    <article class="card"><h3>Top albumy</h3>${list(stats.topAlbums)}</article>
    <article class="card"><h3>Top gatunki</h3>${list(stats.topGenres)}</article>
  `;

  patternsEl.innerHTML = `
    <article class="card">
      <h3>Słuchanie wg dnia tygodnia</h3>
      ${patternList(stats.weekdayHours, (row) => row.day)}
    </article>
    <article class="card">
      <h3>Słuchanie wg godziny</h3>
      ${patternList(stats.hourlyHours, (row) => `${String(row.hour).padStart(2, '0')}:00`)}
    </article>
  `;

  summaryEl.classList.remove('hidden');
  topsEl.classList.remove('hidden');
  patternsEl.classList.remove('hidden');
  renderSourceInfo();
}

function saveCurrentUserData() {
  const record = getCurrentUserRecord();
  if (!record) return;
  ensureUserData(record);
  record.data.historyRows = entries;
  record.data.genreRaw = Object.fromEntries(genreMap.entries());
  record.data.sourceState = sourceState;
  record.settings.timeRange = rangeSelect.value;
  persistStore();
}

function applyDataForCurrentUser() {
  const record = getCurrentUserRecord();
  if (!record) return;
  ensureUserData(record);

  entries = record.data.historyRows;
  genreMap = parseGenreMap(record.data.genreRaw);
  sourceState =
    record.data.sourceState || {
      mode: entries.length ? 'local' : 'none',
      files: [],
      totalRows: entries.length,
      loadedRows: entries.length,
      invalidRows: 0,
      fileErrors: 0,
      importedAt: null
    };

  rangeSelect.value = record.settings.timeRange || 'all';
  rangeCache = new Map();

  if (entries.length) {
    showDashboardStatus(
      `Załadowano ${entries.length} rekordów z lokalnego zapisu użytkownika ${currentUser}.`
    );
    render();
  } else {
    hideResults();
    renderSourceInfo();
    showDashboardStatus('Brak zapisanych danych. Wykonaj pierwszy import JSON/ZIP.');
  }
}

function setCurrentUser(username) {
  currentUser = username;
  setSession(username);
  showDashboardScreen();
  sessionInfo.textContent = `Użytkownik: ${username}`;
  applyDataForCurrentUser();
}

async function registerLocalAccount(username, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltBase64 = toBase64(salt);
  const hash = await hashPassword(password, saltBase64);

  store.users[username] = {
    auth: {
      salt: saltBase64,
      hash
    },
    profile: {
      createdAt: new Date().toISOString()
    },
    data: {
      historyRows: [],
      genreRaw: null,
      sourceState: null
    },
    settings: {
      timeRange: 'all'
    }
  };

  persistStore();
}

async function verifyLocalAccount(username, password) {
  const record = store.users[username];
  if (!record || !record.auth || !record.auth.salt || !record.auth.hash) {
    return false;
  }

  const candidateHash = await hashPassword(password, record.auth.salt);
  return candidateHash === record.auth.hash;
}

async function loadJsonArrayFromFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed)) {
      return { rows: [], errors: [`${file.name}: root value must be an array`] };
    }
    return { rows: parsed, errors: [] };
  } catch {
    return { rows: [], errors: [`${file.name}: invalid JSON`] };
  }
}

async function getZipModule() {
  if (cachedZipModule) return cachedZipModule;
  cachedZipModule = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
  return cachedZipModule;
}

async function loadHistoryRowsFromZip(file) {
  const zipModule = await getZipModule();
  const zip = await zipModule.default.loadAsync(await file.arrayBuffer());
  const rows = [];
  const errors = [];
  const jsonFiles = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith('.json')
  );

  if (jsonFiles.length === 0) {
    errors.push(`${file.name}: archive does not contain JSON files`);
  }

  for (const entry of jsonFiles) {
    try {
      const text = await entry.async('string');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        errors.push(`${file.name}/${entry.name}: root value must be an array`);
        continue;
      }
      rows.push(...parsed);
    } catch {
      errors.push(`${file.name}/${entry.name}: invalid JSON`);
    }
  }

  return { rows, errors };
}

async function readHistoryInputs(fileList) {
  const files = [...fileList];
  const rows = [];
  const errors = [];
  const names = [];

  for (const file of files) {
    names.push(file.name);

    if (file.name.toLowerCase().endsWith('.zip')) {
      try {
        const zipResult = await loadHistoryRowsFromZip(file);
        rows.push(...zipResult.rows);
        errors.push(...zipResult.errors);
      } catch {
        errors.push(`${file.name}: invalid ZIP or unsupported archive`);
      }
      continue;
    }

    const jsonResult = await loadJsonArrayFromFile(file);
    rows.push(...jsonResult.rows);
    errors.push(...jsonResult.errors);
  }

  return { rows, errors, names };
}

async function processImport() {
  const historyFiles = historyInput.files;
  if (!historyFiles || historyFiles.length === 0) {
    showDashboardStatus('Wybierz co najmniej jeden plik JSON lub ZIP do importu.', true);
    return;
  }

  try {
    const { rows: rawRows, errors, names } = await readHistoryInputs(historyFiles);
    const report = normalizeHistoryRowsWithReport(rawRows);

    entries = report.rows;
    rangeCache = new Map();

    if (genreInput.files?.[0]) {
      const parsedGenre = JSON.parse(await genreInput.files[0].text());
      genreMap = parseGenreMap(parsedGenre);
    }

    sourceState = {
      mode: 'import',
      files: names,
      totalRows: report.totalRows,
      loadedRows: report.rows.length,
      invalidRows: report.invalidRows,
      fileErrors: errors.length,
      importedAt: new Date().toISOString()
    };

    saveCurrentUserData();

    const bits = [
      `Zaimportowano ${report.rows.length} rekordów z ${report.totalRows} wierszy`,
      `${report.invalidRows} pominiętych wpisów`,
      `${errors.length} błędów plików/parsingu`
    ];

    showDashboardStatus(bits.join(' · '), report.rows.length === 0);

    if (entries.length) {
      render();
    } else {
      hideResults();
      renderSourceInfo();
    }
  } catch {
    showDashboardStatus('Import nie powiódł się. Sprawdź format plików JSON/ZIP.', true);
  }
}

function loadDemo() {
  entries = createDemoEntries();
  genreMap = parseGenreMap(DEMO_GENRE_MAP_OBJECT);
  rangeCache = new Map();

  sourceState = {
    mode: 'demo',
    files: ['demo-data'],
    totalRows: entries.length,
    loadedRows: entries.length,
    invalidRows: 0,
    fileErrors: 0,
    importedAt: new Date().toISOString()
  };

  saveCurrentUserData();
  showDashboardStatus(`Załadowano ${entries.length} demo rekordów.`);
  render();
}

function clearCurrentUserData() {
  const record = getCurrentUserRecord();
  if (!record) return;

  ensureUserData(record);
  record.data = { historyRows: [], genreRaw: null, sourceState: null };
  record.settings.timeRange = 'all';
  persistStore();

  entries = [];
  genreMap = new Map();
  rangeCache = new Map();
  sourceState = {
    mode: 'none',
    files: [],
    totalRows: 0,
    loadedRows: 0,
    invalidRows: 0,
    fileErrors: 0,
    importedAt: null
  };

  historyInput.value = '';
  genreInput.value = '';
  rangeSelect.value = 'all';
  hideResults();
  renderSourceInfo();
  showDashboardStatus('Lokalne dane użytkownika zostały wyczyszczone.');
}

function logout() {
  currentUser = null;
  clearSession();
  entries = [];
  genreMap = new Map();
  rangeCache = new Map();
  showAuthScreen();
  switchAuthTab('login');
  showAuthMessage('Wylogowano.');
}

loginTabBtn.addEventListener('click', () => switchAuthTab('login'));
registerTabBtn.addEventListener('click', () => switchAuthTab('register'));

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername(loginUsername.value);
  const password = loginPassword.value;

  if (!username || !password) {
    showAuthMessage('Uzupełnij nazwę użytkownika i hasło.', true);
    return;
  }

  const ok = await verifyLocalAccount(username, password);
  if (!ok) {
    showAuthMessage('Niepoprawna nazwa użytkownika lub hasło.', true);
    return;
  }

  showAuthMessage('Zalogowano pomyślnie.');
  loginPassword.value = '';
  setCurrentUser(username);
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = normalizeUsername(registerUsername.value);
  const password = registerPassword.value;

  if (username.length < 3 || password.length < 6) {
    showAuthMessage('Nazwa min. 3 znaki, hasło min. 6 znaków.', true);
    return;
  }

  if (store.users[username]) {
    showAuthMessage('Taki użytkownik już istnieje.', true);
    return;
  }

  await registerLocalAccount(username, password);
  showAuthMessage('Konto utworzone. Możesz się zalogować.');
  registerForm.reset();
  switchAuthTab('login');
});

logoutBtn.addEventListener('click', logout);
importBtn.addEventListener('click', processImport);
loadDemoBtn.addEventListener('click', loadDemo);
clearDataBtn.addEventListener('click', clearCurrentUserData);

rangeSelect.addEventListener('change', () => {
  if (!currentUser) return;
  const record = getCurrentUserRecord();
  if (record) {
    ensureUserData(record);
    record.settings.timeRange = rangeSelect.value;
    persistStore();
  }

  if (entries.length) {
    render();
  }
});

(function init() {
  renderSourceInfo();
  const persistedUser = getSessionUser();
  if (persistedUser && store.users[persistedUser]) {
    setCurrentUser(persistedUser);
    return;
  }

  showAuthScreen();
  switchAuthTab('login');
  showAuthMessage('Zaloguj się lub utwórz konto lokalne.');
})();
