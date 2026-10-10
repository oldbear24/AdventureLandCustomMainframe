// Items page: every item of every character and the bank in one table, with where each lies.
import { $, api, boot, escape, itemIcon, number, on } from './core.js';

const BANK = '__bank__';
const FILTERS = { q: 'items-search', place: 'items-place', owner: 'items-owner', kind: 'items-kind', level: 'items-level', sort: 'items-sort' };
const params = new URLSearchParams(location.search);
let data = null, loading = false;
const placeNames = { bank: 'Banka', inventory: 'inventář', equipment: 'vybavení' };
const GRADES = ['', 'Vysoký', 'Vzácný', 'Legendární', 'Exaltovaný'];

// Filters live in the address, so a filtered view can be bookmarked.
function saveFilters() {
  const url = new URL(location.href);
  for (const [key, id] of Object.entries(FILTERS)) {
    const value = $(id).value.trim();
    if (value && !(key === 'level' && value === '0') && !(key === 'sort' && value === 'title')) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}
for (const [key, id] of Object.entries(FILTERS)) if (params.has(key) && key !== 'owner') $(id).value = params.get(key);

const fullName = item => `${item.specialTitle || item.special || ''} ${item.title}${item.level !== null ? ` +${item.level}` : ''}`.trim();
const ownerKey = location => location.owner ?? BANK;
function locationChip(location) {
  const where = location.owner === null ? 'Banka' : `${location.owner} · ${placeNames[location.place]}`;
  const href = `/inventory?name=${encodeURIComponent(ownerKey(location))}`;
  return `<a class="meta-chip location-chip ${location.place}" href="${href}">${escape(where)}${location.count > 1 ? ` <b>×${number(location.count)}</b>` : ''}${location.locked ? ' 🔒' : ''}</a>`;
}
// Unlocked pieces outside equipment, per item and level: three of them can be compounded.
function compoundable() {
  const counts = new Map();
  for (const item of data.items) {
    if (item.upgrade !== 'compound') continue;
    const key = `${item.name}|${item.level}`;
    counts.set(key, (counts.get(key) || 0) + item.locations.filter(l => l.place !== 'equipment' && !l.locked).reduce((sum, l) => sum + l.count, 0));
  }
  return counts;
}
function filtered() {
  const query = $('items-search').value.trim().toLowerCase(), place = $('items-place').value, owner = $('items-owner').value;
  const kind = $('items-kind').value, level = Number($('items-level').value) || 0, triples = compoundable();
  const rows = [];
  for (const item of data.items) {
    const locations = item.locations.filter(l => (!place || l.place === place) && (!owner || ownerKey(l) === owner));
    if (!locations.length) continue;
    if (query && !`${item.title} ${item.name} ${item.specialTitle || ''} ${item.type || ''}`.toLowerCase().includes(query)) continue;
    if (kind === 'upgrade' && item.upgrade !== 'upgrade') continue;
    if (kind === 'compound' && item.upgrade !== 'compound') continue;
    if (kind === 'triples' && (triples.get(`${item.name}|${item.level}`) || 0) < 3) continue;
    if (kind === 'other' && item.upgrade) continue;
    if (level && (item.level ?? 0) < level) continue;
    rows.push({ item, locations, count: locations.reduce((sum, l) => sum + l.count, 0), compound: item.upgrade === 'compound' ? triples.get(`${item.name}|${item.level}`) || 0 : 0 });
  }
  const sort = $('items-sort').value;
  if (sort === 'total') rows.sort((a, b) => b.count - a.count || a.item.title.localeCompare(b.item.title));
  else if (sort === 'level') rows.sort((a, b) => (b.item.level ?? -1) - (a.item.level ?? -1) || a.item.title.localeCompare(b.item.title));
  return rows;
}
function renderOwners() {
  const current = $('items-owner').value || params.get('owner') || '';
  params.delete('owner');
  const owners = data.sources.filter(s => s.kind === 'character' && !s.error).map(s => s.name);
  const html = `<option value="">Všechny</option>${owners.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join('')}<option value="${BANK}">Banka</option>`;
  if ($('items-owner').dataset.html !== html) { $('items-owner').innerHTML = html; $('items-owner').dataset.html = html; }
  $('items-owner').value = [...$('items-owner').options].some(o => o.value === current) ? current : '';
}
function render() {
  renderOwners();
  const rows = filtered(), pieces = rows.reduce((sum, r) => sum + r.count, 0);
  const sources = data.sources.map(s => {
    const label = s.kind === 'bank' ? 'Banka' : s.name;
    if (s.error) return `<span class="meta-chip draft" title="${escape(s.error)}">⚠ ${escape(label)}: nenačteno</span>`;
    return `<span class="meta-chip ${s.source === 'live' ? 'running' : ''}" title="${escape(s.observedAt ? new Date(s.observedAt).toLocaleString('cs-CZ') : 'stáří neznámé')}">${s.source === 'live' ? '● ' : ''}${escape(label)} · ${number(s.gold)} G</span>`;
  }).join('');
  $('items-summary').innerHTML = `<span class="meta-chip slot">${number(rows.length)} druhů · ${number(pieces)} ks</span><span class="meta-chip">Zlato celkem ${number(data.gold)} G</span>${sources}<span class="meta-chip">Načteno ${escape(new Date(data.generatedAt).toLocaleTimeString('cs-CZ'))}</span>`;
  $('items-table').innerHTML = rows.length ? `<table class="party-table items-table"><thead><tr><th>Předmět</th><th>Úroveň</th><th>Počet</th><th>Kde</th></tr></thead><tbody>${rows.map(({ item, locations, count, compound }) => {
    const tip = [fullName(item), item.description, item.type && `Typ: ${item.type}`].filter(Boolean).join('\n');
    const tags = [item.grade ? `<span class="tag grade-${item.grade}">${GRADES[item.grade]}</span>` : '', compound >= 3 ? `<span class="tag slot" title="${number(compound)} odemčených kusů mimo vybavení">COMPOUND ×${Math.floor(compound / 3)}</span>` : ''].join('');
    return `<tr data-item="${escape(item.key)}"><td><div class="item-cell" title="${escape(tip)}">${itemIcon(item.icon, 24)}<span><strong>${escape(item.specialTitle || item.special ? `${item.specialTitle || item.special} ` : '')}${escape(item.title)}</strong><small>${escape(item.name)}</small></span>${tags}</div></td><td>${item.level !== null ? `+${item.level}` : '—'}</td><td><b>${number(count)}</b></td><td><div class="location-list">${locations.map(locationChip).join('')}</div></td></tr>`;
  }).join('')}</tbody></table>` : '<p class="muted">Žádný předmět neodpovídá filtrům.</p>';
}
async function load(refresh = false) {
  if (loading) return; loading = true;
  $('items-refresh').disabled = true;
  try { data = await api(refresh ? '/items?refresh=1' : '/items'); render(); }
  catch (error) { $('items-table').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; $('items-refresh').disabled = false; }
}
let opened = false;
on('dashboard', offline => { if (!offline && !opened) { opened = true; load(); } });
on('reset', () => { opened = false; data = null; $('items-table').innerHTML = ''; $('items-summary').innerHTML = ''; });
for (const id of Object.values(FILTERS)) $(id).addEventListener(id === 'items-search' ? 'input' : 'change', () => { saveFilters(); if (data) render(); });
$('items-refresh').addEventListener('click', () => load(true));

await boot();
