// Inline-SVG charts. Colors come from CSS tokens (classes), so light/dark both work.
// Spec: thin marks (≤24px bars, 4px rounded data-end, square at baseline), 2px lines,
// ≥8px markers with a surface ring, 1px recessive gridlines, hover tooltips, one y-axis.
import { html, setHTML, trusted, fmtInt } from '../lib/utils.js';

const NS_W = (el) => Math.max(260, Math.round(el.getBoundingClientRect().width || el.clientWidth || 320));

/** Nice round axis ticks covering [0 or min, max]. */
export function niceTicks(min, max, count = 4) {
  if (!(max > min)) max = min + 1;
  const span = max - min;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || 10 * pow;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}

/** Rounded-top bar path: 4px radius at the data end, square at the baseline. */
function barPath(x, y, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function tipLayer(el) {
  let tip = el.querySelector('.chart-tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; el.appendChild(tip); }
  return tip;
}
function showTip(el, x, y, title, sub) {
  const tip = tipLayer(el);
  setHTML(tip, html`${title}${sub ? html`<small>${sub}</small>` : ''}`);
  tip.hidden = false;
  const w = el.clientWidth;
  tip.style.left = `${Math.min(Math.max(x, 60), w - 60)}px`;
  tip.style.top = `${y}px`;
}
const hideTip = (el) => { const t = el.querySelector('.chart-tip'); if (t) t.hidden = true; };

/** Re-renders `draw` on resize. Returns a disposer. */
function responsive(el, draw) {
  draw();
  if (!('ResizeObserver' in window)) return () => {};
  let last = NS_W(el);
  const ro = new ResizeObserver(() => { const w = NS_W(el); if (Math.abs(w - last) > 8) { last = w; draw(); } });
  ro.observe(el);
  return () => ro.disconnect();
}

/**
 * Column chart. data: [{ key, label, sub, value, className }]
 * opts: { goal, goalLabel, height, format(v), unit, onSelect(key), activeKey }
 */
export function barChart(el, data, opts = {}) {
  el.classList.add('chart');
  const { goal = 0, height = 190, format = fmtInt, unit = '', onSelect, activeKey, goalLabel = 'Goal' } = opts;
  const draw = () => {
    const W = NS_W(el), H = height;
    const pad = { t: 14, r: 8, b: 36, l: 40 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const maxV = Math.max(goal || 0, ...data.map((d) => d.value || 0)) * 1.08 || 1;
    const ticks = niceTicks(0, maxV, 3);
    const top = ticks[ticks.length - 1];
    const y = (v) => pad.t + ih - (v / top) * ih;
    const band = iw / data.length;
    const bw = Math.min(24, band * 0.62);
    // Thin the x labels when bars are narrow; always keep the last (most recent) one.
    const every = Math.max(1, Math.ceil(30 / band));
    const showLabel = (i) => (data.length - 1 - i) % every === 0;
    let s = '';
    for (const t of ticks) {
      s += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
      s += `<text class="axis-text" x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${fmtInt(t)}</text>`;
    }
    data.forEach((d, i) => {
      const cx = pad.l + band * i + band / 2;
      const v = d.value || 0;
      const h = v > 0 ? Math.max(2, (v / top) * ih) : 0;
      const cls = v > 0 ? (d.className || '') : 'empty';
      s += `<g class="bar-group" data-i="${i}">`;
      s += `<rect class="bar-hit" x="${cx - band / 2}" y="${pad.t}" width="${band}" height="${ih + pad.b}"/>`;
      s += v > 0 ? `<path class="bar-mark ${cls}" d="${barPath(cx - bw / 2, y(v), bw, h)}"/>` : `<rect class="bar-mark empty" x="${cx - bw / 2}" y="${pad.t + ih - 2}" width="${bw}" height="2" rx="1"/>`;
      const strong = d.key === activeKey ? ' strong' : '';
      if (showLabel(i) || d.key === activeKey) {
        s += `<text class="axis-text${strong}" x="${cx}" y="${H - 20}" text-anchor="middle">${escText(d.label)}</text>`;
        if (d.sub) s += `<text class="axis-text${strong}" x="${cx}" y="${H - 7}" text-anchor="middle">${escText(d.sub)}</text>`;
      }
      s += '</g>';
    });
    if (goal > 0) {
      s += `<line class="goal-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(goal)}" y2="${y(goal)}"/>`;
      s += `<text class="goal-text" x="${W - pad.r}" y="${y(goal) - 4}" text-anchor="end">${escText(goalLabel)} ${fmtInt(goal)}</text>`;
    }
    setHTML(el, html`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${opts.ariaLabel || 'Bar chart'}">${trusted(s)}</svg>`);
    const svg = el.querySelector('svg');
    svg.addEventListener('mousemove', (e) => {
      const g = e.target.closest('.bar-group');
      if (!g) return hideTip(el);
      const d = data[Number(g.dataset.i)];
      const cx = pad.l + band * Number(g.dataset.i) + band / 2;
      showTip(el, cx, y(Math.max(d.value || 0, 0)) - 4, `${format(d.value || 0)}${unit ? ` ${unit}` : ''}`, d.title || `${d.label} ${d.sub || ''}`.trim());
    });
    svg.addEventListener('mouseleave', () => hideTip(el));
    if (onSelect) {
      svg.style.cursor = 'pointer';
      svg.addEventListener('click', (e) => { const g = e.target.closest('.bar-group'); if (g) onSelect(data[Number(g.dataset.i)].key); });
    }
  };
  return responsive(el, draw);
}

/**
 * Line chart over dates. points: [{ date: 'YYYY-MM-DD', value, label }] ascending.
 * opts: { target, targetLabel, height, format(v), unit, emptyText }
 */
export function lineChart(el, points, opts = {}) {
  el.classList.add('chart');
  const { target = null, height = 200, format = (v) => v.toFixed(1), unit = '', targetLabel = 'Target' } = opts;
  if (points.length < 2) {
    setHTML(el, html`<div class="chart-empty">${opts.emptyText || 'Add at least two entries to see a trend.'}</div>`);
    return () => {};
  }
  const draw = () => {
    const W = NS_W(el), H = height;
    const pad = { t: 16, r: 44, b: 26, l: 40 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const t0 = Date.parse(points[0].date), t1 = Date.parse(points[points.length - 1].date);
    const vals = points.map((p) => p.value).concat(target != null ? [target] : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padV = Math.max(0.5, (hi - lo) * 0.12);
    lo -= padV; hi += padV;
    const ticks = niceTicks(lo, hi, 4).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9);
    const x = (d) => pad.l + (t1 === t0 ? iw / 2 : ((Date.parse(d) - t0) / (t1 - t0)) * iw);
    const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;
    let s = '';
    for (const t of ticks) {
      s += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
      s += `<text class="axis-text" x="${pad.l - 6}" y="${y(t) + 3}" text-anchor="end">${escText(format(t))}</text>`;
    }
    const xLabels = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of xLabels) {
      const p = points[i];
      s += `<text class="axis-text" x="${x(p.date)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${escText(p.label)}</text>`;
    }
    if (target != null) {
      s += `<line class="goal-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(target)}" y2="${y(target)}"/>`;
      s += `<text class="goal-text" x="${pad.l + 4}" y="${y(target) - 4}">${escText(targetLabel)} ${escText(format(target))}</text>`;
    }
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = `${line}L${x(points[points.length - 1].date).toFixed(1)},${pad.t + ih}L${x(points[0].date).toFixed(1)},${pad.t + ih}Z`;
    s += `<path class="area" d="${area}"/><path class="line" d="${line}"/>`;
    if (points.length <= 40) for (const p of points) s += `<circle class="pt" cx="${x(p.date)}" cy="${y(p.value)}" r="3"/>`;
    const last = points[points.length - 1];
    s += `<circle class="pt" cx="${x(last.date)}" cy="${y(last.value)}" r="5"/>`;
    s += `<text class="axis-text strong" x="${x(last.date) + 8}" y="${y(last.value) + 4}">${escText(format(last.value))}</text>`;
    s += `<line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
    setHTML(el, html`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${opts.ariaLabel || 'Line chart'}">${trusted(s)}</svg>`);
    const svg = el.querySelector('svg');
    const cross = svg.querySelector('.crosshair');
    const move = (clientX) => {
      const r = svg.getBoundingClientRect();
      const mx = ((clientX - r.left) / r.width) * W;
      let best = points[0], bd = Infinity;
      for (const p of points) { const d = Math.abs(x(p.date) - mx); if (d < bd) { bd = d; best = p; } }
      cross.setAttribute('x1', x(best.date)); cross.setAttribute('x2', x(best.date)); cross.setAttribute('visibility', 'visible');
      showTip(el, (x(best.date) / W) * r.width, (y(best.value) / H) * r.height - 6, `${format(best.value)}${unit ? ` ${unit}` : ''}`, best.title || best.label);
    };
    svg.addEventListener('mousemove', (e) => move(e.clientX));
    svg.addEventListener('touchmove', (e) => move(e.touches[0].clientX), { passive: true });
    const leave = () => { cross.setAttribute('visibility', 'hidden'); hideTip(el); };
    svg.addEventListener('mouseleave', leave);
    svg.addEventListener('touchend', leave);
  };
  return responsive(el, draw);
}

/** Small trend line for stat cards (no axes). */
export function sparkline(values, { width = 110, height = 40 } = {}) {
  if (values.length < 2) return html``;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => [2 + (i / (values.length - 1)) * (width - 8), 4 + (1 - (v - lo) / span) * (height - 8)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const [lx, ly] = pts[pts.length - 1];
  return trusted(`<svg class="chart sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path class="line" d="${d}"/><circle class="pt" cx="${lx}" cy="${ly}" r="4"/></svg>`);
}

/** Progress ring (SVG). pct 0..∞; over=true switches to the "over goal" color. */
export function ring(pct, { size = 148, stroke = 12, over = false } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, Math.max(0, pct)));
  return trusted(`<svg viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/><circle class="fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`);
}

function escText(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
