import { buildStats, filterByRange, normalizeHistoryRows, parseGenreMap } from './analytics.js';

const historyInput = document.getElementById('historyFiles');
const genreInput = document.getElementById('genreFile');
const rangeSelect = document.getElementById('timeRange');
const status = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const topsEl = document.getElementById('tops');
const patternsEl = document.getElementById('patterns');

let entries = [];
let genreMap = new Map();

function list(items) {
  if (!items.length) return '<p>No data in this range.</p>';
  return `<ol>${items
    .map((item) => `<li>${item.label} · ${item.hours}h · ${item.plays} plays</li>`)
    .join('')}</ol>`;
}

function render() {
  const selectedRange = rangeSelect.value;
  const filtered = filterByRange(entries, selectedRange);
  const stats = buildStats(filtered, genreMap);

  summaryEl.innerHTML = `
    <h2>Summary (${selectedRange})</h2>
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
  const contents = await Promise.all(files.map((file) => file.text()));
  return contents.flatMap((text) => JSON.parse(text));
}

historyInput.addEventListener('change', async (event) => {
  const files = event.target.files;
  if (!files || files.length === 0) {
    entries = [];
    status.textContent = 'No data loaded yet.';
    return;
  }

  try {
    const rawRows = await readJsonFiles(files);
    entries = normalizeHistoryRows(rawRows);
    status.textContent = `Loaded ${entries.length} listening events.`;
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
    status.textContent = `${status.textContent} Genre map loaded for ${genreMap.size} artists.`;
    if (entries.length) render();
  } catch {
    status.textContent = 'Could not parse the genre JSON file.';
  }
});

rangeSelect.addEventListener('change', () => {
  if (entries.length) render();
});
