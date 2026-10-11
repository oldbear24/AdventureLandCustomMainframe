// Monsters page: which monster to farm, from the public game data, with base XP, gold, drops and spawn maps.
import { $, api, boot, decimal, escape, itemIcon, number, on, pageFromUrl, pageSize, pager, paginate, savePageInUrl, savePageSize } from './core.js';

const FILTERS = { q: 'monster-search', map: 'monster-map', damage: 'monster-damage', hp: 'monster-max-hp', sort: 'monster-sort' };
const DEFAULTS = { sort: 'xpPerHp' };
const params = new URLSearchParams(location.search);
for (const [key, id] of Object.entries(FILTERS)) if (params.has(key)) $(id).value = params.get(key);
if (params.get('all') === '1') $('monster-spawning').checked = false;
let monsters = null, loading = false, page = pageFromUrl(), size = pageSize('monsters');
const DAMAGE = { physical: 'fyzický', magical: 'magický', pure: 'čistý' };

function saveFilters() {
  const url = new URL(location.href);
  for (const [key, id] of Object.entries(FILTERS)) { const value = $(id).value.trim(); if (value && value !== DEFAULTS[key]) url.searchParams.set(key, value); else url.searchParams.delete(key); }
  if ($('monster-spawning').checked) url.searchParams.delete('all'); else url.searchParams.set('all', '1');
  history.replaceState(null, '', url);
}
// Drop chances span from 1 to 1e-7; show them as a percentage with two significant digits and as "1 in N".
const chance = value => `${new Intl.NumberFormat('cs-CZ', { maximumSignificantDigits: 2 }).format(value * 100)} %`;
const oneIn = value => value >= 0.5 ? '' : ` (1 : ${number(1 / value)})`;
const ratio = (a, b) => a !== null && b ? a / b : null;
function rows() {
  const query = $('monster-search').value.trim().toLowerCase(), map = $('monster-map').value, damage = $('monster-damage').value;
  const maxHp = Number($('monster-max-hp').value) || Infinity, spawning = $('monster-spawning').checked, sort = $('monster-sort').value;
  const list = monsters.filter(m => (!spawning || m.spawns.length) && (!map || m.spawns.some(s => s.map === map)) && (!damage || m.damageType === damage) && m.hp <= maxHp &&
    (!query || `${m.name} ${m.key} ${m.drops.map(d => `${d.title} ${d.item}`).join(' ')}`.toLowerCase().includes(query)));
  const value = m => sort === 'xpPerHp' ? ratio(m.xp, m.hp) : sort === 'goldPerHp' ? ratio(m.gold, m.hp) : m[sort];
  return list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : (value(b) ?? -1) - (value(a) ?? -1) || a.name.localeCompare(b.name));
}
function renderMaps() {
  const maps = new Map();
  for (const m of monsters) for (const s of m.spawns) maps.set(s.map, s.title);
  const current = $('monster-map').value || params.get('map') || '';
  $('monster-map').innerHTML = `<option value="">Všechny mapy</option>${[...maps].sort((a, b) => a[1].localeCompare(b[1])).map(([key, title]) => `<option value="${escape(key)}">${escape(title)}</option>`).join('')}`;
  $('monster-map').value = maps.has(current) ? current : '';
}
function render() {
  const view = paginate(rows(), page, size), list = view.rows;
  page = view.page; savePageInUrl(page);
  $('monster-table').innerHTML = list.length ? `<table class="party-table monster-table"><thead><tr><th>Monstrum</th><th>HP</th><th>XP</th><th>XP/HP</th><th>Zlato</th><th>Útok</th><th>Obrana</th><th>Kde</th><th>Nejčastější dropy</th></tr></thead><tbody>${list.map(m => `<tr data-monster="${escape(m.key)}" tabindex="0">
    <td><strong>${escape(m.name)}</strong>${m.boss ? ' <span class="tag draft">BOSS</span>' : ''}${m.cooperative ? ' <span class="tag" title="Odměna se dělí mezi všechny útočníky">CO-OP</span>' : ''}<small>${escape(m.key)}</small></td>
    <td>${number(m.hp)}</td><td>${m.xp === null ? '—' : number(m.xp)}</td><td><b>${m.xp === null ? '—' : decimal(m.xp / m.hp)}</b></td><td>${m.gold === null ? '—' : number(m.gold)}</td>
    <td>${number(m.attack)} <small>${escape(DAMAGE[m.damageType] || '')}${m.frequency ? ` · ${decimal(m.frequency)}/s` : ''}</small></td>
    <td><small>${[m.armor && `brnění ${number(m.armor)}`, m.resistance && `rezist. ${number(m.resistance)}`, m.evasion && `úhyb ${number(m.evasion)}`].filter(Boolean).join(' · ') || '—'}</small></td>
    <td><div class="location-list">${m.spawns.slice(0, 3).map(s => `<a class="meta-chip location-chip" href="/map?map=${encodeURIComponent(s.map)}">${escape(s.title)}${s.count ? ` <b>×${number(s.count)}</b>` : ''}</a>`).join('')}${m.spawns.length > 3 ? `<span class="meta-chip location-chip">+${m.spawns.length - 3}</span>` : ''}</div></td>
    <td><div class="drop-list">${m.drops.slice(0, 3).map(d => `<span class="drop" title="${escape(`${d.title}: ${chance(d.chance)}${oneIn(d.chance)}`)}">${itemIcon(d.icon, 20)}<span>${escape(d.title)}</span><small>${chance(d.chance)}</small></span>`).join('') || '<small class="muted">—</small>'}</div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Žádné monstrum neodpovídá filtrům.</p>';
  pager($('monster-pager'), view, (next, nextSize) => { page = next; size = nextSize; savePageSize('monsters', size); render(); $('monster-table').scrollIntoView({ block: 'nearest' }); });
}
function openMonster(key) {
  const m = monsters.find(x => x.key === key); if (!m) return;
  $('monster-dialog-title').textContent = m.name;
  const facts = [['HP', number(m.hp)], ['MP', m.mp === null ? '—' : number(m.mp)], ['XP za zabití', m.xp === null ? '—' : number(m.xp)], ['XP na HP', m.xp === null ? '—' : decimal(m.xp / m.hp)], ['Základní zlato', m.gold === null ? '—' : number(m.gold)],
    ['Útok', `${number(m.attack)} (${DAMAGE[m.damageType] || '?'})`], ['Útoků za sekundu', m.frequency === null ? '—' : decimal(m.frequency)], ['Dosah', m.range === null ? '—' : number(m.range)], ['Rychlost', m.speed === null ? '—' : number(m.speed)],
    ['Brnění', number(m.armor)], ['Rezistence', number(m.resistance)], ['Úhyb', `${decimal(m.evasion)} %`], ['Agresivita', m.aggro === null ? '—' : `${decimal(m.aggro * 100)} %`]];
  $('monster-detail').innerHTML = `<p class="fine"><code>${escape(m.key)}</code>${m.boss ? ' · boss' : ''}${m.cooperative ? ' · kooperativní (odměna se dělí)' : ''}${m.poisonous ? ' · jedovaté' : ''}</p><table class="item-stats"><tbody>${facts.map(([name, value]) => `<tr><th>${escape(name)}</th><td>${escape(value)}</td></tr>`).join('')}</tbody></table><h3 class="inventory-section">Výskyt</h3>${m.spawns.length ? `<div class="location-list">${m.spawns.map(s => `<a class="meta-chip location-chip" href="/map?map=${encodeURIComponent(s.map)}">${escape(s.title)}${s.count ? ` <b>×${number(s.count)}</b>` : ''}</a>`).join('')}</div>` : '<p class="fine">Neobjevuje se v běžných zónách map (boss, událost nebo vyvolané monstrum).</p>'}<h3 class="inventory-section">Dropy <small>${m.drops.length}</small></h3>${m.drops.length ? `<table class="item-stats drops-table"><tbody>${m.drops.map(d => `<tr><th><span class="drop">${itemIcon(d.icon, 20)}<span>${escape(d.title)}${d.quantity ? ` ×${number(d.quantity)}` : ''}</span></span></th><td>${chance(d.chance)}<small>${oneIn(d.chance)}</small></td></tr>`).join('')}</tbody></table>` : '<p class="fine">Žádné vlastní dropy; platí jen dropy mapy a globální dropy.</p>'}`;
  if (!$('monster-dialog').open) $('monster-dialog').showModal();
}
async function load() {
  if (loading) return; loading = true;
  try { monsters = (await api('/monsters')).monsters; renderMaps(); render(); }
  catch (error) { $('monster-table').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; }
}
let opened = false;
on('dashboard', offline => { if (!offline && !opened) { opened = true; load(); } });
on('reset', () => { opened = false; });
for (const id of Object.values(FILTERS)) $(id).addEventListener(id === 'monster-search' ? 'input' : 'change', () => { page = 1; saveFilters(); if (monsters) render(); });
$('monster-spawning').addEventListener('change', () => { page = 1; saveFilters(); if (monsters) render(); });
$('monster-table').addEventListener('click', event => { if (event.target.closest('a')) return; const row = event.target.closest('[data-monster]'); if (row) openMonster(row.dataset.monster); });
$('monster-table').addEventListener('keydown', event => { const row = event.target.closest('[data-monster]'); if (row && event.key === 'Enter') openMonster(row.dataset.monster); });
$('close-monster').addEventListener('click', () => $('monster-dialog').close());

await boot();
