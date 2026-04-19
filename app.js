import { buildStats, filterByRange, normalizeHistoryRowsWithReport, parseGenreMap } from './analytics.js';

const historyInput = document.getElementById('historyFiles');
const genreInput = document.getElementById('genreFile');
const rangeSelect = document.getElementById('timeRange');
const status = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const topsEl = document.getElementById('tops');
const patternsEl = document.getElementById('patterns');

let entries = [];
let genreMap = new Map();
let rangeCache = new Map();

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
  return `<ol>${items
    .map(
      (item) =>
        `<li>${escapeHtml(item.label)} · ${item.hours}h · ${item.plays} plays</li>`
    )
    .join('')}</ol>`;
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
      <ul>${stats.weekdayHours
        .map((row) => `<li>${row.day}: ${row.hours}h</li>`)
        .join('')}</ul>
    </article>
    <article class="card">
      <h3>Listening by hour</h3>
      <ul>${stats.hourlyHours
        .map((row) => `<li>${String(row.hour).padStart(2, '0')}:00 — ${row.hours}h</li>`)
        .join('')}</ul>
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
