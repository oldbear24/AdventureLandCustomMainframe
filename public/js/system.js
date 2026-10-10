// System page: CPU and memory of the container, Chromium and the panel, the data volume and each character's browser.
import { $, api, boot, decimal, duration, escape, number, on } from './core.js';

let data = null, loading = false;
const bytes = value => {
  if (value === null || value === undefined) return '—';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let v = value, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: v < 10 && i ? 1 : 0 }).format(v)} ${units[i]}`;
};
const percent = value => value === null || value === undefined ? '—' : `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} %`;
const meter = (value, max) => max ? `<div class="meter system-meter ${value / max > 0.9 ? 'danger' : value / max > 0.75 ? 'warn' : ''}"><i style="--fill:${Math.min(100, value / max * 100)}%"></i></div>` : '';

function tiles() {
  const { latest, host, disk, data: files } = data, cg = latest.cgroup;
  const cpuMax = cg.cpuLimit ?? host.cpus;
  const memoryMax = cg.memoryLimit ?? host.totalMemory, memoryUsed = cg.memoryUsed ?? host.totalMemory - host.freeMemory;
  const cpu = cg.cpu ?? ((latest.node.cpu ?? 0) + (latest.browser?.cpu ?? 0));
  return [
    ['CPU KONTEJNERU', percent(cpu), `${cg.cpuLimit ? `limit ${decimal(cg.cpuLimit)} CPU` : `${host.cpus} jader serveru`}`, meter(cpu, cpuMax * 100)],
    ['PAMĚŤ', bytes(memoryUsed), `${cg.memoryLimit ? 'z limitu' : 'ze serveru'} ${bytes(memoryMax)}`, meter(memoryUsed, memoryMax)],
    ['CHROMIUM', latest.browser ? bytes(latest.browser.rss) : '—', latest.browser ? `${number(latest.browser.processes)} procesů · CPU ${percent(latest.browser.cpu)}` : 'procesy nejsou dostupné', ''],
    ['DATA', disk ? bytes(disk.free) : '—', disk ? `volno z ${bytes(disk.total)} · data ${bytes(files?.bytes)}` : 'neznámé', disk ? meter(disk.total - disk.free, disk.total) : ''],
  ].map(([label, value, note, bar]) => `<div><p>${label}</p><strong>${escape(value)}</strong><small>${escape(note)}</small>${bar}</div>`).join('');
}
// One series per chart, so no legend: the title names it. The crosshair reads the nearest sample.
function lineChart(container, points, format, max) {
  if (points.length < 2) { container.innerHTML = '<p class="muted">Sbírám data; první hodnoty se objeví do 20 sekund.</p>'; return; }
  const width = Math.max(260, container.clientWidth || 500), height = 150, left = 54, right = 12, top = 10, bottom = 22;
  const t0 = points[0].t, t1 = points.at(-1).t, span = Math.max(1, t1 - t0);
  // The axis ends at a round value just above the data (or at the given maximum).
  const peak = Math.max(max ?? 0, ...points.map(p => p.v)) || 1, power = 10 ** Math.floor(Math.log10(peak));
  const top_ = max !== null && peak <= max ? max : [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(m => m * power).find(v => v >= peak * 1.05) || peak;
  const x = t => left + (t - t0) / span * (width - left - right), y = v => top + (1 - v / top_) * (height - top - bottom);
  const grid = [0, 0.5, 1].map(f => `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(top_ * f)}" y2="${y(top_ * f)}"/><text class="tick" x="${left - 8}" y="${y(top_ * f) + 4}" text-anchor="end">${escape(format(top_ * f))}</text>`).join('');
  const labels = [t0, t1].map((t, i) => `<text class="tick" x="${x(t)}" y="${height - 5}" text-anchor="${i ? 'end' : 'start'}">${escape(new Date(t).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }))}</text>`).join('');
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const last = points.at(-1);
  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escape(container.closest('section').querySelector('h2').textContent)}">${grid}${labels}<path class="area" d="${d}L${x(last.t)},${y(0)}L${x(t0)},${y(0)}Z"/><path class="line" d="${d}"/><circle class="end-dot" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/><line class="crosshair" y1="${top}" y2="${height - bottom}" visibility="hidden"/><rect class="hit" x="${left}" y="0" width="${width - left - right}" height="${height}" tabindex="0"/></svg>`;
  const svg = container.querySelector('svg'), hit = svg.querySelector('.hit'), hair = svg.querySelector('.crosshair'), tip = $('system-tip');
  const show = (point, clientX, clientY) => {
    hair.setAttribute('x1', x(point.t)); hair.setAttribute('x2', x(point.t)); hair.setAttribute('visibility', 'visible');
    tip.replaceChildren();
    const value = document.createElement('strong'); value.textContent = format(point.v);
    const time = document.createElement('div'); time.className = 'tip-title'; time.textContent = new Date(point.t).toLocaleTimeString('cs-CZ');
    tip.append(time, value); tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - 140, clientX + 14)}px`; tip.style.top = `${clientY + 14}px`;
  };
  hit.addEventListener('pointermove', event => {
    const box = svg.getBoundingClientRect(), t = t0 + ((event.clientX - box.left) * width / box.width - left) / (width - left - right) * span;
    show(points.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), event.clientX, event.clientY);
  });
  const hide = () => { hair.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  hit.addEventListener('pointerleave', hide); hit.addEventListener('blur', hide);
  hit.addEventListener('focus', () => { const box = hit.getBoundingClientRect(); show(last, box.right - 120, box.top); });
}
function render() {
  const { latest, host, history, characters } = data;
  $('system-updated').textContent = `Aktualizováno ${new Date(latest.t).toLocaleTimeString('cs-CZ')} · obnova každých 10 s`;
  $('system-tiles').innerHTML = tiles();
  const cpuMax = (latest.cgroup.cpuLimit ?? host.cpus) * 100, memoryMax = latest.cgroup.memoryLimit ?? host.totalMemory;
  lineChart($('system-cpu'), history.filter(p => p.cpu !== null).map(p => ({ t: p.t, v: p.cpu })), percent, Math.min(cpuMax, 100));
  lineChart($('system-memory'), history.map(p => ({ t: p.t, v: p.memory })), bytes, null);
  $('system-memory-note').textContent = `Posledních 15 minut · ${latest.cgroup.memoryLimit ? `limit kontejneru ${bytes(memoryMax)}` : `paměť serveru ${bytes(memoryMax)}`}`;
  $('system-characters').innerHTML = characters.length ? `<table class="party-table"><thead><tr><th>Postava</th><th>Stav</th><th>Ping</th><th>Paměť JS</th><th>Prvky stránky</th><th>Běží</th><th>Pokusy o připojení</th></tr></thead><tbody>${characters.map(c => `<tr data-character="${escape(c.id)}"><td><strong>${escape(c.name)}</strong></td><td><span class="tag ${c.status === 'running' ? 'slot' : 'draft'}">${escape({ running: 'ONLINE', starting: 'STARTUJI', reconnecting: 'OBNOVUJI' }[c.status] || c.status)}</span></td><td>${c.ping === null ? '—' : `${number(c.ping)} ms`}</td><td>${c.heapUsed === null ? '—' : `${bytes(c.heapUsed)} <small>/ ${bytes(c.heapTotal)}</small>`}</td><td>${c.nodes === null ? '—' : number(c.nodes)}</td><td>${c.startedAt ? duration(data.now - Date.parse(c.startedAt)) : '—'}</td><td>${number(c.attempts)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Žádná postava neběží.</p>';
  const facts = [
    ['Systém', host.platform], ['Node.js', host.node], ['Jádra CPU', number(host.cpus)], ['Zátěž (1 / 5 / 15 min)', host.load.map(v => decimal(v)).join(' / ')],
    ['Paměť serveru', `${bytes(host.totalMemory - host.freeMemory)} z ${bytes(host.totalMemory)}`], ['Panel (Node.js)', `${bytes(latest.node.rss)} · heap ${bytes(latest.node.heapUsed)} · CPU ${percent(latest.node.cpu)}`],
    ['Běh panelu', duration(data.process.uptime * 1000)], ['Běh serveru', duration(host.uptime * 1000)],
    ['Datový adresář', data.data ? `${number(data.data.files)} souborů · ${bytes(data.data.bytes)}` : '—'],
  ];
  $('system-host').innerHTML = facts.map(([name, value]) => `<div><small>${escape(name)}</small><strong>${escape(value)}</strong></div>`).join('');
}
async function load() {
  if (loading) return; loading = true;
  try { data = await api('/system'); render(); }
  catch (error) { $('system-tiles').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; }
}
// The server samples every 10 seconds; every second dashboard refresh is enough.
let ticks = 0;
on('dashboard', offline => { if (!offline && ticks++ % 2 === 0) load(); });
on('reset', () => { ticks = 0; data = null; });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (data) render(); }, 150); });

await boot();
