import { buildStats, filterByRange, normalizeHistoryRowsWithReport, parseGenreMap } from './analytics.js';

const historyInput = document.getElementById('historyFiles');
const genreInput = document.getElementById('genreFile');
const rangeSelect = document.getElementById('timeRange');
const status = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const topsEl = document.getElementById('tops');
const patternsEl = document.getElementById('patterns');
const loadDemoBtn = document.getElementById('loadDemoBtn');
const clearDataBtn = document.getElementById('clearDataBtn');
const MIN_TOP_BAR_WIDTH_PERCENT = 4;
const MIN_PATTERN_BAR_WIDTH_PERCENT = 2;

let entries = [];
let genreMap = new Map();
let rangeCache = new Map();
const DEMO_GENRE_MAP = new Map([
  ['Daft Punk', ['electronic', 'french house']],
  ['The Weeknd', ['r&b', 'pop']],
  ['Tame Impala', ['psychedelic rock', 'indie']],
  ['Dua Lipa', ['pop', 'dance pop']],
  ['Arctic Monkeys', ['indie rock', 'alternative']]
]);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function list(items) {
  if (!items.length) return '<p>No data in this range.</p>';
  const maxHours = Math.max(...items.map((item) => item.hours), 0);
  return `<ol class="bar-list">${items
    .map(
      (item) => {
        const width =
          maxHours > 0
            ? Math.max((item.hours / maxHours) * 100, MIN_TOP_BAR_WIDTH_PERCENT)
            : 0;
        return `<li class="bar-row">
          <div class="bar-label">${escapeHtml(item.label)}</div>
          <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
          <div class="bar-meta">${item.hours}h · ${item.plays} plays</div>
        </li>`;
      }
    )
    .join('')}</ol>`;
}

function patternList(rows, labelBuilder) {
  if (!rows.length) return '<p>No data in this range.</p>';
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

function hideResults() {
  summaryEl.classList.add('hidden');
  topsEl.classList.add('hidden');
  patternsEl.classList.add('hidden');
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
    for (let s = 0; s < sessions; s += 1) {
      const pick = artists[(day + s) % artists.length];
      const timestamp = new Date(
        now.getTime() - day * 24 * 60 * 60 * 1000 + (8 + ((day + s) % 14)) * 60 * 60 * 1000
      );
      demo.push({
        timestamp: timestamp.toISOString(),
        artist: pick.artist,
        track: pick.track,
        album: pick.album,
        msPlayed: 120_000 + ((day * 17 + s * 23) % 200_000)
      });
    }
  }

  return demo;
}

function render() {
  const selectedRange = rangeSelect.value;
  if (!rangeCache.has(selectedRange)) {
    const filtered = filterByRange(entries, selectedRange);
    rangeCache.set(selectedRange, buildStats(filtered, genreMap));
  }
  const stats = rangeCache.get(selectedRange);

  summaryEl.innerHTML = `
    <h2>Summary (${escapeHtml(selectedRange)})</h2>
    <div class="kpi"><span>Total plays</span><strong>${stats.summary.totalPlays}</strong></div>
    <div class="kpi"><span>Total hours listened</span><strong>${stats.summary.totalHours}h</strong></div>
    <div class="kpi"><span>Avg daily listening</span><strong>${stats.summary.avgDailyMinutes} min</strong></div>
  `;

  topsEl.innerHTML = `
    <article class="card"><h3>Top artists</h3>${list(stats.topArtists)}</article>
    <article class="card"><h3>Top tracks</h3>${list(stats.topTracks)}</article>
    <article class="card"><h3>Top albums</h3>${list(stats.topAlbums)}</article>
    <article class="card"><h3>Top genres</h3>${list(stats.topGenres)}</article>
  `;

  patternsEl.innerHTML = `
    <article class="card">
      <h3>Listening by weekday</h3>
      ${patternList(stats.weekdayHours, (row) => row.day)}
    </article>
    <article class="card">
      <h3>Listening by hour</h3>
      ${patternList(stats.hourlyHours, (row) => `${String(row.hour).padStart(2, '0')}:00`)}
    </article>
  `;

  summaryEl.classList.remove('hidden');
  topsEl.classList.remove('hidden');
  patternsEl.classList.remove('hidden');
}

async function readJsonFiles(fileList) {
  const files = [...fileList];
  const contents = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
  const rows = [];
  const errors = [];

  for (const file of contents) {
    try {
      const parsed = JSON.parse(file.text);
      if (!Array.isArray(parsed)) {
        errors.push(`${file.name}: root value must be an array`);
        continue;
      }
      rows.push(...parsed);
    } catch {
      errors.push(`${file.name}: invalid JSON`);
    }
  }

  return { rows, errors };
}

historyInput.addEventListener('change', async (event) => {
  const files = event.target.files;
  if (!files || files.length === 0) {
    entries = [];
    rangeCache = new Map();
    hideResults();
    status.textContent = 'No data loaded yet.';
    return;
  }

  try {
    const { rows: rawRows, errors } = await readJsonFiles(files);
    const report = normalizeHistoryRowsWithReport(rawRows);
    entries = report.rows;
    rangeCache = new Map();
    const statusBits = [
      `Loaded ${entries.length} listening events from ${report.totalRows} rows`
    ];
    if (report.invalidRows > 0) statusBits.push(`${report.invalidRows} rows skipped`);
    if (errors.length > 0) statusBits.push(`${errors.length} file(s) had parsing issues`);
    status.textContent = `${statusBits.join(' · ')}.`;
    render();
  } catch {
    status.textContent = 'Could not parse one of the history JSON files.';
  }
});

genreInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
    if (!file) {
    genreMap = new Map();
    if (entries.length) render();
    return;
  }

  try {
    genreMap = parseGenreMap(JSON.parse(await file.text()));
    rangeCache = new Map();
    status.textContent = `${status.textContent} Genre map loaded for ${genreMap.size} artists.`;
    if (entries.length) render();
  } catch {
    status.textContent = 'Could not parse the genre JSON file.';
  }
});

rangeSelect.addEventListener('change', () => {
  if (entries.length) render();
});

loadDemoBtn.addEventListener('click', () => {
  entries = createDemoEntries();
  genreMap = new Map(DEMO_GENRE_MAP);
  rangeCache = new Map();
  status.textContent = `Loaded ${entries.length} demo listening events with a sample genre map.`;
  render();
});

clearDataBtn.addEventListener('click', () => {
  entries = [];
  genreMap = new Map();
  rangeCache = new Map();
  historyInput.value = '';
  genreInput.value = '';
  hideResults();
  status.textContent = 'No data loaded yet.';
});
