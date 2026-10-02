// Measure: the smart scale (Cult Smart Scale over Bluetooth), manual weigh-ins, the latest
// result with its estimated body composition, and the full weigh-in history.
import { html, setHTML, fmtNum, formatDay } from '../lib/utils.js';
import { formatWeight } from '../lib/nutrition.js';
import { sortWeights } from '../lib/stats.js';
import { state, on, weightUnit } from '../store.js';
import { $, bindActions, confirmDialog, toast } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { deleteWeight } from '../services/data.js';
import { bluetoothSupport } from '../services/scale.js';
import { openScale, openWeightSheet, openBluetoothHelp, resultView, howCalculated } from './weigh-in.js';

const PAGE = 30;

export function mountMeasure(root) {
  const disposers = [];
  let shown = PAGE;
  const support = bluetoothSupport();

  setHTML(root, html`
    <div class="page-head"><div><h1>Measure</h1><p class="small muted">Weight and body composition</p></div></div>
    <div class="dash-grid">
      <div class="cards">
        <section class="card scale-card" aria-label="Smart scale">
          <div class="row">
            <div class="scale-hero small" aria-hidden="true">${icon('scale', 28)}</div>
            <div class="grow"><h2 class="card-title">Cult Smart Scale</h2>
              <p class="small muted">${support === 'ok' ? 'Connects over Bluetooth — weight, heart rate and body composition in about 30 seconds.'
                : support === 'ios' ? 'On iPhone or iPad, open NutriLog in the Bluefy browser to use the scale.' : 'This browser can’t use Bluetooth. Use Chrome or Edge, or log your weight manually.'}</p></div>
          </div>
          <div class="row wrap" style="margin-top:14px">
            <button type="button" class="btn btn-primary btn-lg" data-action="measure">${icon('bluetooth', 18)} Measure with scale</button>
            <button type="button" class="btn btn-secondary btn-lg" data-action="log-weight">${icon('edit', 18)} Log manually</button>
          </div>
          <button type="button" class="link-btn" data-action="help" style="margin-top:8px">Bluetooth help</button>
        </section>
        <section class="card" id="m-latest" aria-label="Latest weigh-in"></section>
      </div>
      <div class="cards">
        <section class="card" id="m-history" aria-label="Weigh-ins"></section>
      </div>
    </div>`);

  const render = () => {
    const unit = weightUnit();
    const w = sortWeights(state.weights);
    const latest = w[w.length - 1];
    setHTML($('#m-latest', root), latest ? html`
      <div class="card-head"><h2 class="card-title">Latest weigh-in</h2><span class="small muted">${formatDay(latest.recorded_on)}${latest.source === 'scale' ? ' · smart scale' : ''}</span></div>
      ${resultView(latest, { previous: w[w.length - 2] || null, unit })}
      ${howCalculated()}`
      : html`<div class="empty"><div class="empty-icon">⚖️</div><div class="empty-title">No weigh-ins yet</div>
        <div class="empty-sub">Measure with your smart scale or log your weight to start tracking.</div>
        <button type="button" class="btn btn-primary btn-sm" data-action="measure">Measure your weight</button></div>`);

    const list = [...w].reverse();
    setHTML($('#m-history', root), html`
      <div class="card-head"><h2 class="card-title">Weigh-ins</h2><span class="small muted">${list.length} total</span></div>
      ${list.length ? html`${list.slice(0, shown).map((x, i) => {
        const prev = list[i + 1];
        const diff = prev ? Number(x.weight_kg) - Number(prev.weight_kg) : null;
        const meta = [formatDay(x.recorded_on), x.source === 'scale' ? 'smart scale' : x.source === 'import' ? 'imported' : null,
          x.body_fat_pct != null ? `${fmtNum(x.body_fat_pct, 1)}% fat (est.)` : null, x.heart_rate_bpm ? `${x.heart_rate_bpm} bpm` : null,
          x.pending ? 'saving…' : null].filter(Boolean).join(' · ');
        return html`<div class="item">
          <div class="item-main"><div class="item-name">${formatWeight(x.weight_kg, unit)}</div><div class="item-meta">${meta}</div></div>
          ${diff != null ? html`<span class="small ${diff < 0 ? 'muted' : ''}">${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${formatWeight(Math.abs(diff), unit)}</span>` : ''}
          <button type="button" class="icon-btn" data-action="del-weight" data-date="${x.recorded_on}" aria-label="Delete weigh-in on ${formatDay(x.recorded_on)}">${icon('trash', 18)}</button>
        </div>`;
      })}
      ${list.length > shown ? html`<button type="button" class="btn btn-ghost btn-block" data-action="more">Show older weigh-ins</button>` : ''}`
        : html`<p class="small muted">Your weigh-ins will be listed here.</p>`}`);
  };

  disposers.push(bindActions(root, {
    measure: () => openScale(),
    'log-weight': () => openWeightSheet(),
    help: () => openBluetoothHelp(),
    more: () => { shown += PAGE; render(); },
    'del-weight': async (el) => {
      const d = el.dataset.date;
      if (await confirmDialog({ title: 'Delete weigh-in?', message: `Remove the entry for ${formatDay(d)}?`, confirmLabel: 'Delete', danger: true })) {
        deleteWeight(d); toast('Weigh-in deleted.');
      }
    },
  }));
  disposers.push(on('weights', render));
  disposers.push(on('account', render));
  render();
  return () => disposers.forEach((d) => d());
}
