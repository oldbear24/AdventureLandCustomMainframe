// Stats page: long-term XP and gold of every character from the persistent five-minute samples.
import { $, api, app, boot, duration, escape, number, on, signed } from './core.js';

const RANGES = ['24h', '3d', '7d', '14d', '30d', '90d', '1y'];
const SERIES = 8;
let range = RANGES.includes(new URLSearchParams(location.search).get('range')) ? new URLSearchParams(location.search).get('range') : '24h';
let data = null, loading = false;
// Color follows the character, never its rank: slots are handed out once per page in name order and kept.
const colors = new Map();
const colorOf = name => {
  if (!colors.has(name)) colors.set(name, colors.size < SERIES ? `var(--series-${colors.size + 1})` : 'var(--series-other)');
  return colors.get(name);
};
const compact = value => new Intl.NumberFormat('cs-CZ', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const SVG = 'http://www.w3.org/2000/svg';

// Clean tick values for an axis from min to max.
function ticks(min, max, count = 4) {
  if (min === max) { max = min + 1; }
  const raw = (max - min) / count, power = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw);
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}
const timeLabel = (t, span) => span > 2 * 86_400_000
  ? new Date(t).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })
  : new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
const fullTime = t => new Date(t).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

// Shared tooltip: values lead, character names follow; built with textContent.
function showTip(event, title, rows) {
  const tip = $('chart-tip');
  tip.replaceChildren();
  const head = document.createElement('div'); head.className = 'tip-title'; head.textContent = title; tip.append(head);
  for (const row of rows) {
    const line = document.createElement('div'); line.className = 'tip-row';
    const key = document.createElement('i'); key.style.background = row.color;
    const value = document.createElement('strong'); value.textContent = row.value;
    const name = document.createElement('span'); name.textContent = row.name;
    line.append(key, value, name); tip.append(line);
  }
  tip.hidden = false;
  const box = tip.getBoundingClientRect(), x = Math.min(window.innerWidth - box.width - 12, event.clientX + 14), y = Math.min(window.innerHeight - box.height - 12, event.clientY + 14);
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { $('chart-tip').hidden = true; };

function frame(container, height) {
  const width = Math.max(280, container.clientWidth || 600);
  return { width, height, left: 54, right: 16, top: 12, bottom: 26 };
}
// xTicks are times; a tick can also be { t, at } to label time t at another position (a column's center).
function axes(f, yTicks, y, xTicks, x, span, format) {
  const grid = yTicks.map(v => `<line class="grid" x1="${f.left}" x2="${f.width - f.right}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${f.left - 8}" y="${y(v) + 4}" text-anchor="end">${escape(format(v))}</text>`).join('');
  const xs = xTicks.map(tick => `<text class="tick" x="${x(tick.at ?? tick)}" y="${f.height - 6}" text-anchor="middle">${escape(timeLabel(tick.t ?? tick, span))}</text>`).join('');
  return grid + xs;
}

// One line per character with a crosshair that lists every character at the hovered time.
function lineChart(container, key, format) {
  const series = data.characters.map(c => ({ name: c.name, color: colorOf(c.name), points: c.series.map(p => ({ t: p.t, v: p[key], gap: p.gap })) })).filter(s => s.points.length);
  if (!series.length) { container.innerHTML = '<p class="muted">V tomto období nejsou žádné vzorky.</p>'; return; }
  const f = frame(container, 230), span = data.to - data.from;
  const values = series.flatMap(s => s.points.map(p => p.v));
  const yTicks = ticks(Math.min(0, ...values), Math.max(0, ...values));
  const x = t => f.left + (t - data.from) / span * (f.width - f.left - f.right);
  const y = v => f.top + (1 - (v - yTicks[0]) / (yTicks.at(-1) - yTicks[0])) * (f.height - f.top - f.bottom);
  const xTicks = Array.from({ length: 5 }, (_, i) => data.from + span * i / 4);
  const paths = series.map(s => {
    const d = s.points.map((p, i) => `${i === 0 || p.gap ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const last = s.points.at(-1);
    return `<path class="line" data-series="${escape(s.name)}" d="${d}" style="stroke:${s.color}"/><circle class="end-dot" cx="${x(last.t)}" cy="${y(last.v)}" r="4" style="fill:${s.color}"/>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 ${f.width} ${f.height}" width="${f.width}" height="${f.height}" role="img" aria-label="${escape(container.closest('section').querySelector('h2').textContent)}">${axes(f, yTicks, y, xTicks, x, span, format)}<line class="baseline" x1="${f.left}" x2="${f.width - f.right}" y1="${y(0)}" y2="${y(0)}"/>${paths}<line class="crosshair" y1="${f.top}" y2="${f.height - f.bottom}" visibility="hidden"/><rect class="hit" x="${f.left}" y="0" width="${f.width - f.left - f.right}" height="${f.height}" tabindex="0"/></svg>`;
  const svg = container.querySelector('svg'), hair = svg.querySelector('.crosshair'), hit = svg.querySelector('.hit');
  const times = [...new Set(series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b);
  let index = times.length - 1;
  const show = (t, event) => {
    hair.setAttribute('x1', x(t)); hair.setAttribute('x2', x(t)); hair.setAttribute('visibility', 'visible');
    // Each character's sample nearest the hovered time, if it ran then.
    const rows = series.map(s => {
      const nearest = s.points.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best);
      return { name: s.name, color: s.color, value: Math.abs(nearest.t - t) <= (data.detailed === false ? 3_600_000 : 15 * 60_000) ? format(nearest.v, true) : 'neběžela' };
    });
    showTip(event, fullTime(t), rows);
  };
  hit.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect(), t = data.from + ((event.clientX - box.left) * f.width / box.width - f.left) / (f.width - f.left - f.right) * span;
    index = times.reduce((best, value, i) => Math.abs(value - t) < Math.abs(times[best] - t) ? i : best, 0);
    show(times[index], event);
  });
  const leave = () => { hair.setAttribute('visibility', 'hidden'); hideTip(); };
  hit.addEventListener('pointerleave', leave); hit.addEventListener('blur', leave);
  const keyboard = () => { const box = hit.getBoundingClientRect(); show(times[index], { clientX: box.left + (x(times[index]) - f.left) / (f.width - f.left - f.right) * box.width, clientY: box.top + 20 }); };
  hit.addEventListener('focus', keyboard);
  hit.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); index = Math.max(0, Math.min(times.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); keyboard();
  });
}

// XP per hour or day, stacked per character; each column is its own hover target.
function barChart(container) {
  const characters = data.characters.filter(c => c.buckets.some(b => b.xp > 0));
  if (!characters.length) { container.innerHTML = '<p class="muted">V tomto období postavy nezískaly žádné XP.</p>'; return; }
  const f = frame(container, 230), count = data.characters[0].buckets.length, span = data.to - data.from;
  const totals = Array.from({ length: count }, (_, i) => characters.reduce((sum, c) => sum + c.buckets[i].xp, 0));
  const yTicks = ticks(0, Math.max(...totals));
  const band = (f.width - f.left - f.right) / count, width = Math.min(24, band * 0.7);
  const x = t => f.left + (t - data.from) / span * (f.width - f.left - f.right);
  const y = v => f.top + (1 - v / yTicks.at(-1)) * (f.height - f.top - f.bottom);
  const step = Math.max(1, Math.ceil(count / 6));
  const xTicks = data.characters[0].buckets.filter((_, i) => i % step === 0).map(b => ({ t: b.t, at: b.t + data.bucketMs / 2 }));
  const columns = totals.map((total, i) => {
    if (!total) return '';
    let top = y(0), segments = '';
    const parts = characters.map(c => ({ c, v: c.buckets[i].xp })).filter(p => p.v > 0);
    parts.forEach((part, k) => {
      const height = y(0) - y(part.v), last = k === parts.length - 1;
      // A 2px surface gap separates the stacked segments; only the top end is rounded.
      const h = Math.max(1, height - (k ? 2 : 0)), x0 = f.left + band * i + (band - width) / 2, y0 = top - height;
      const r = last ? Math.min(4, h / 2, width / 2) : 0;
      segments += `<path d="M${x0},${y0 + h}V${y0 + r}${r ? `Q${x0},${y0} ${x0 + r},${y0}` : ''}H${x0 + width - r}${r ? `Q${x0 + width},${y0} ${x0 + width},${y0 + r}` : ''}V${y0 + h}Z" style="fill:${colorOf(part.c.name)}"/>`;
      top = y0;
    });
    return `<g class="column" data-index="${i}" tabindex="0"><rect class="hit-col" x="${f.left + band * i}" y="${f.top}" width="${band}" height="${f.height - f.top - f.bottom}"/>${segments}</g>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 ${f.width} ${f.height}" width="${f.width}" height="${f.height}" role="img" aria-label="XP za období">${axes(f, yTicks, y, xTicks, x, span, compact)}<line class="baseline" x1="${f.left}" x2="${f.width - f.right}" y1="${y(0)}" y2="${y(0)}"/>${columns}</svg>`;
  const show = (group, event) => {
    const i = Number(group.dataset.index), bucket = data.characters[0].buckets[i];
    const rows = characters.filter(c => c.buckets[i].xp > 0).map(c => ({ name: c.name, color: colorOf(c.name), value: `${number(c.buckets[i].xp)} XP` }));
    showTip(event, `${fullTime(bucket.t)} – ${fullTime(bucket.t + data.bucketMs)} · celkem ${number(totals[i])} XP`, rows);
  };
  for (const group of container.querySelectorAll('.column')) {
    group.addEventListener('pointermove', event => show(group, event));
    group.addEventListener('pointerleave', hideTip);
    group.addEventListener('focus', () => { const box = group.getBoundingClientRect(); show(group, { clientX: box.right, clientY: box.top }); });
    group.addEventListener('blur', hideTip);
  }
}

function render() {
  for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed', String(button.dataset.range === range));
  const list = data.characters, sum = key => list.reduce((total, c) => total + (c[key] || 0), 0);
  $('stats-tiles').innerHTML = `<div><p>ZÍSKANÉ XP</p><strong>${compact(sum('xpGained'))}</strong><small>${number(sum('xpGained'))} XP</small></div><div><p>ZMĚNA ZLATA</p><strong>${signed(sum('goldChange'))}</strong><small>všechny postavy</small></div><div><p>NOVÉ LEVELY</p><strong>${number(sum('levels'))}</strong><small>smrti ${number(sum('deaths'))} · výpadky ${number(sum('disconnects'))}</small></div><div><p>ČAS ONLINE</p><strong>${duration(sum('onlineMs'))}</strong><small>součet postav</small></div>`;
  if (!data.available || !list.length) {
    $('stats-body').innerHTML = `<div class="empty"><h2>Zatím žádná data.</h2><p>${data.available ? 'Spusť postavu; první vzorek se uloží hned a další každých 5 minut.' : 'Historie není na tomto serveru dostupná.'}</p></div>`;
    return;
  }
  for (const c of [...list].sort((a, b) => a.name.localeCompare(b.name))) colorOf(c.name);
  $('stats-legend').innerHTML = list.map(c => `<span><i style="background:${colorOf(c.name)}"></i>${escape(c.name)}</span>`).join('');
  lineChart($('chart-xp'), 'xp', (v, exact) => exact ? `${number(v)} XP` : compact(v));
  lineChart($('chart-gold'), 'gold', (v, exact) => exact ? `${signed(v)} G` : compact(v));
  $('chart-bars-title').textContent = data.bucketMs >= 7 * 86_400_000 ? 'XP za týden' : data.bucketMs >= 86_400_000 ? 'XP za den' : data.bucketMs > 3_600_000 ? `XP za ${data.bucketMs / 3_600_000} hodin` : 'XP za hodinu';
  $('chart-bars-note').textContent = 'Najetím na sloupec uvidíš rozpad po postavách.';
  barChart($('chart-bars'));
  $('stats-table').innerHTML = `<table class="party-table stats-table"><thead><tr><th>Postava</th><th>Level</th><th>XP</th><th>XP/h</th><th>Zlato</th><th>Gold/h</th><th>Online</th><th>Levely</th><th>Smrti</th><th>Výpadky</th></tr></thead><tbody>${list.map(c => `<tr data-character="${escape(c.id)}"><td><span class="series-key" style="background:${colorOf(c.name)}"></span><strong>${escape(c.name)}</strong></td><td>${c.levelStart === c.levelEnd ? number(c.levelEnd) : `${number(c.levelStart)} → ${number(c.levelEnd)}`}</td><td>${number(c.xpGained)}</td><td>${c.xpPerHour === null ? '—' : number(c.xpPerHour)}</td><td class="${c.goldChange < 0 ? 'negative' : ''}">${signed(c.goldChange)}</td><td>${c.goldPerHour === null ? '—' : signed(c.goldPerHour)}</td><td>${duration(c.onlineMs)}</td><td>${number(c.levels)}</td><td>${number(c.deaths)}</td><td>${number(c.disconnects)}</td></tr>`).join('')}</tbody></table>`;
}
// The page body is replaced by the empty state; restore it before drawing charts again.
const bodyTemplate = $('stats-body').innerHTML;
async function load() {
  if (loading) return; loading = true;
  $('stats-body').classList.add('refreshing');
  try {
    data = await api(`/history/stats?range=${range}&offset=${-new Date().getTimezoneOffset()}`);
    if (!$('chart-xp')) $('stats-body').innerHTML = bodyTemplate;
    render();
  } catch (error) { $('stats-tiles').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; $('stats-body').classList.remove('refreshing'); }
}
let opened = false, lastLoad = 0;
// New samples arrive every five minutes, so the page reloads at most once a minute.
on('dashboard', offline => {
  if (offline || Date.now() - lastLoad < 60_000) return;
  if (!opened) for (const c of [...app.dashboard.characters].sort((a, b) => a.name.localeCompare(b.name))) colorOf(c.name);
  opened = true; lastLoad = Date.now(); load();
});
on('reset', () => { opened = false; lastLoad = 0; data = null; });
document.querySelector('.range-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-range]'); if (!button || button.dataset.range === range) return;
  range = button.dataset.range;
  const url = new URL(location.href);
  if (range === '24h') url.searchParams.delete('range'); else url.searchParams.set('range', range);
  history.replaceState(null, '', url);
  lastLoad = Date.now(); load();
});
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data && $('chart-xp')) render(); }, 150); });

await boot();
