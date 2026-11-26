/*
 * SpotiStats — wykres liniowy w czystym SVG (bez bibliotek).
 * window.SpotiCharts.lineChart(container, options)
 *
 * options = {
 *   buckets: [epoch ms],             // początki kubełków
 *   unit: 'day' | 'week' | 'month',
 *   series: [{ name, color, values }],
 *   height: 300,
 *   area: false                      // wypełnienie pod linią (dla pojedynczej serii)
 * }
 */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
  const MONTHS_LONG = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function niceStep(max, count) {
    const raw = max / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function fmtMinutes(v) {
    if (v >= 600) return `${Math.round(v / 60)} h`;
    if (v >= 60) return `${(v / 60).toFixed(1).replace('.', ',')} h`;
    return `${Math.round(v)} min`;
  }

  function axisLabel(ms, unit, multiYear) {
    const d = new Date(ms);
    if (unit === 'month') {
      return multiYear ? `${MONTHS_SHORT[d.getMonth()]} ’${String(d.getFullYear()).slice(2)}` : MONTHS_SHORT[d.getMonth()];
    }
    const base = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
    return multiYear ? `${base} ’${String(d.getFullYear()).slice(2)}` : base;
  }

  function bucketTitle(ms, unit) {
    const d = new Date(ms);
    if (unit === 'month') return `${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
    if (unit === 'week') {
      const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
      const left = d.getMonth() === e.getMonth() ? `${d.getDate()}` : `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
      return `Tydzień ${left}–${e.getDate()} ${MONTHS_SHORT[e.getMonth()]} ${e.getFullYear()}`;
    }
    return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function lineChart(container, opts) {
    const { buckets, unit, series } = opts;
    const height = opts.height || 300;
    container.innerHTML = '';
    container.classList.add('chart');

    if (!buckets.length || !series.length) {
      container.innerHTML = '<p class="no-data">Brak danych w tym zakresie.</p>';
      return;
    }

    const width = Math.max(container.clientWidth || 600, 280);
    const rank = Boolean(opts.rank); // tryb rankingu: 1 na górze, null = poza topką
    const pad = { top: 12, right: 12, bottom: 28, left: rank ? 36 : 52 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;

    let maxV = 0;
    for (const s of series) for (const v of s.values) if (v != null && v > maxV) maxV = v;
    // Oś Y w minutach albo godzinach — zależnie od skali.
    const useHours = maxV >= 180;
    const scaleMax = useHours ? maxV / 60 : maxV;
    const step = niceStep(scaleMax || 1, 4);
    const top = Math.max(step, Math.ceil((scaleMax || 1) / step) * step);
    const yMax = useHours ? top * 60 : top;

    const n = buckets.length;
    const x = (i) => pad.left + (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const maxRank = opts.maxRank || 10;
    // rankOut: najniższy poziom (maxRank) znaczy „poza topką” — linia tam schodzi, ale nie ciągnie się po dnie.
    const outLevel = rank && opts.rankOut ? maxRank : 0;
    const isIn = (v) => v != null && v !== outLevel;
    const y = rank
      ? (v) => pad.top + ((v - 1) / Math.max(1, maxRank - 1)) * h
      : (v) => pad.top + h - (v / yMax) * h;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', class: 'chart-svg' });
    svg.setAttribute('aria-label', `Wykres liniowy: ${series.map((s) => s.name).join(', ')}`);

    // Siatka + oś Y
    const grid = el('g', { class: 'chart-grid' }, svg);
    if (rank) {
      for (let r = 1; r <= maxRank; r++) {
        el('line', { x1: pad.left, x2: pad.left + w, y1: y(r), y2: y(r), class: r === 1 ? 'chart-baseline' : '' }, grid);
        const t = el('text', { x: pad.left - 8, y: y(r) + 4, 'text-anchor': 'end', class: 'chart-tick' }, grid);
        t.textContent = outLevel && r === outLevel ? 'dalej' : `#${r}`;
      }
    }
    for (let v = 0; !rank && v <= top + 1e-9; v += step) {
      const yy = y(useHours ? v * 60 : v);
      el('line', { x1: pad.left, x2: pad.left + w, y1: yy, y2: yy, class: v === 0 ? 'chart-baseline' : '' }, grid);
      const t = el('text', { x: pad.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'chart-tick' }, grid);
      const num = Number.isInteger(v) ? v : v.toFixed(1).replace('.', ',');
      t.textContent = `${num}${useHours ? ' h' : ' min'}`;
    }

    // Oś X — ok. jedna etykieta na 90 px
    const multiYear = new Date(buckets[0]).getFullYear() !== new Date(buckets[n - 1]).getFullYear();
    const maxLabels = Math.max(2, Math.floor(w / 90));
    const every = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += every) {
      const t = el('text', { x: x(i), y: height - 8, 'text-anchor': i === 0 && n > 1 ? 'start' : 'middle', class: 'chart-tick' }, grid);
      t.textContent = axisLabel(buckets[i], unit, multiYear);
    }

    // Linie
    const lines = el('g', { class: 'chart-lines' }, svg);
    for (const s of series) {
      // null przerywa linię (np. wykonawca wypadł z top 10 w danym tygodniu)
      let d = '';
      let pen = false;
      if (outLevel) {
        // Odcinek tylko tam, gdzie choć jeden koniec jest w topce.
        let last = -1;
        for (let i = 1; i < n; i++) {
          const a = s.values[i - 1], b = s.values[i];
          if (a == null || b == null || (!isIn(a) && !isIn(b))) continue;
          if (last !== i - 1) d += `M${x(i - 1).toFixed(1)},${y(a).toFixed(1)}`;
          d += `L${x(i).toFixed(1)},${y(b).toFixed(1)}`;
          last = i;
        }
      } else {
        s.values.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        });
      }
      if (rank && n <= 24) {
        // Pojedyncze okresy bez sąsiadów byłyby niewidoczne — kropki dla każdego punktu w topce.
        s.values.forEach((v, i) => { if (isIn(v)) el('circle', { cx: x(i), cy: y(v), r: v === 1 ? 4 : 3, fill: s.color }, lines); });
      }
      if (opts.area && series.length === 1) {
        el('path', { d: `${d}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`, fill: s.color, 'fill-opacity': 0.14, stroke: 'none' }, lines);
      }
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': s.name }, lines);
      if (n === 1) el('circle', { cx: x(0), cy: y(s.values[0]), r: 4, fill: s.color }, lines);
    }

    // Warstwa najechania: pionowa linia + kropki + dymek
    const hover = el('g', { class: 'chart-hover', visibility: 'hidden' }, svg);
    const vline = el('line', { y1: pad.top, y2: pad.top + h, class: 'chart-crosshair' }, hover);
    const dots = series.map((s) => el('circle', { r: 4.5, fill: s.color, class: 'chart-dot' }, hover));
    const hit = el('rect', { x: pad.left - 6, y: pad.top, width: w + 12, height: h, fill: 'transparent' }, svg);

    const tip = document.createElement('div');
    tip.className = 'chart-tip hidden';
    container.appendChild(svg);
    container.appendChild(tip);

    function show(i) {
      hover.setAttribute('visibility', 'visible');
      vline.setAttribute('x1', x(i));
      vline.setAttribute('x2', x(i));
      series.forEach((s, k) => {
        const v = s.values[i];
        const hiddenDot = rank ? !isIn(v) : v == null;
        dots[k].setAttribute('visibility', hiddenDot ? 'hidden' : 'visible');
        if (hiddenDot) return;
        dots[k].setAttribute('cx', x(i));
        dots[k].setAttribute('cy', y(v));
      });
      const rows = series
        .map((s) => ({ s, v: s.values[i] }))
        .filter(({ v }) => !rank || isIn(v))
        .sort((a, b) => (rank ? a.v - b.v : b.v - a.v))
        .map(({ s, v }) => `<div class="chart-tip__row"><span class="swatch" style="background:${s.color}"></span><span class="chart-tip__name">${esc(s.name)}</span><span class="chart-tip__val">${rank ? `#${v}` : fmtMinutes(v)}</span></div>`)
        .join('');
      const extra = opts.tipExtra ? opts.tipExtra(i) : '';
      tip.innerHTML = `<div class="chart-tip__title">${bucketTitle(buckets[i], unit)}</div>${extra}${rows || '<div class="chart-tip__row">—</div>'}`;
      tip.classList.remove('hidden');
      const tipW = tip.offsetWidth;
      let left = x(i) + 14;
      if (left + tipW > width) left = x(i) - 14 - tipW;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${pad.top}px`;
    }
    function hide() {
      hover.setAttribute('visibility', 'hidden');
      tip.classList.add('hidden');
    }
    function indexAt(evt) {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * width;
      if (n === 1) return 0;
      return Math.min(n - 1, Math.max(0, Math.round(((px - pad.left) / w) * (n - 1))));
    }
    hit.addEventListener('pointermove', (e) => show(indexAt(e)));
    hit.addEventListener('pointerdown', (e) => show(indexAt(e)));
    hit.addEventListener('pointerleave', hide);
  }

  root.SpotiCharts = { lineChart, fmtMinutes, bucketTitle, esc };
})(globalThis);
