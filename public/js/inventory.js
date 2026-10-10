// Inventory page: equipment, inventory and gold of each character, and the account's bank.
import { $, api, app, boot, decimal, ensureOwned, escape, itemIcon, number, on, runningSessions } from './core.js';

const BANK = '__bank__';
let inventoryTarget = new URLSearchParams(location.search).get('name'), inventoryData = null, inventoryJson = '', inventoryLoading = false;
function inventoryNames() {
  const names = new Map();
  for (const c of app.dashboard.characters) names.set(c.name.toLowerCase(), c.name);
  for (const c of app.owned) if (!names.has(c.name.toLowerCase())) names.set(c.name.toLowerCase(), c.name);
  return [...names.values()];
}
function renderInventoryTargets() {
  const running = new Set(runningSessions().map(s => s.state.name?.toLowerCase()));
  const rows = inventoryNames().map(name => {
    const owned = app.owned.find(c => c.name.toLowerCase() === name.toLowerCase());
    return `<button class="script-item" role="listitem" data-inventory="${escape(name)}" aria-current="${inventoryTarget === name}"><strong>${escape(name)}</strong><span class="tag ${running.has(name.toLowerCase()) ? 'slot' : 'draft'}">${running.has(name.toLowerCase()) ? 'ŽIVĚ' : 'ULOŽENÝ STAV'}</span>${owned ? `<small>${escape(owned.class)} · LVL ${number(owned.level)}</small>` : ''}</button>`;
  });
  rows.push(`<button class="script-item bank-item" role="listitem" data-inventory="${BANK}" aria-current="${inventoryTarget === BANK}"><strong>⛁ Banka účtu</strong><small>Zlato a všechny trezory</small></button>`);
  const html = rows.join('');
  if ($('inventory-targets').dataset.html !== html) { $('inventory-targets').innerHTML = html; $('inventory-targets').dataset.html = html; }
}
async function loadInventory(quiet = false) {
  if (!inventoryTarget || inventoryLoading) return;
  const target = inventoryTarget; inventoryLoading = true;
  if (!quiet) $('inventory-detail').innerHTML = '<p class="muted">Načítám…</p>';
  try {
    const data = await api(target === BANK ? '/bank' : `/inventories/${encodeURIComponent(target)}`);
    // A quiet refresh that brings the same contents leaves the page untouched.
    const json = JSON.stringify({ ...data, observedAt: undefined, retrievedAt: undefined });
    if (target === inventoryTarget && (!quiet || json !== inventoryJson)) { inventoryData = data; inventoryJson = json; renderInventory(); }
  } catch (error) {
    if (target === inventoryTarget && !quiet) { inventoryData = null; inventoryJson = ''; $('inventory-detail').innerHTML = `<div class="section-head"><h2>${escape(target === BANK ? 'Banka účtu' : target)}</h2><button class="ghost small-button" data-inventory-reload>↻ Obnovit</button></div><p class="error">${escape(error.message)}</p>`; }
  } finally { inventoryLoading = false; }
}
function selectTarget(target) {
  inventoryTarget = target; inventoryData = null; inventoryJson = '';
  const url = new URL(location.href);
  if (target) url.searchParams.set('name', target); else url.searchParams.delete('name');
  history.replaceState(null, '', url);
  renderInventoryTargets(); loadInventory();
}
// Stat labels as the game's item window names them; values marked % are percentages there too.
const STAT_LABELS = { gold: 'Zlato', luck: 'Štěstí', xp: 'XP', lifesteal: 'Lifesteal', manasteal: 'Manasteal', evasion: 'Úhyb', miss: 'Minutí', reflection: 'Odraz', dreturn: 'Vrácené poškození', crit: 'Kritický zásah', critdamage: 'Kritické poškození', attack: 'Poškození', range: 'Dosah', hp: 'HP', str: 'Síla', int: 'Inteligence', dex: 'Obratnost', vit: 'Vitalita', for: 'Odolnost (for)', mp: 'MP', mp_cost: 'MP za útok', mp_reduction: 'Snížení MP skillů', stat: 'Stat', armor: 'Brnění', apiercing: 'Průraz brnění', rpiercing: 'Průraz rezistence', resistance: 'Rezistence', pnresistance: 'Odolnost vůči jedu', firesistance: 'Odolnost vůči ohni', fzresistance: 'Odolnost vůči mrazu', phresistance: 'Odolnost vůči úderům', stresistance: 'Odolnost vůči stavům', speed: 'Rychlost', frequency: 'Rychlost útoku', output: 'Výstup poškození', incdmgamp: 'Příchozí poškození', stun: 'Omráčení', explosion: 'Exploze', blast: 'Výbuch', breaks: 'Rozbití', charisma: 'Charisma', awesomeness: 'Úžasnost', bling: 'Bling', cuteness: 'Roztomilost', courage: 'Odvaha', mcourage: 'Magická odvaha', pcourage: 'Fyzická odvaha' };
const PERCENT_STATS = new Set(['gold', 'luck', 'xp', 'lifesteal', 'manasteal', 'evasion', 'miss', 'reflection', 'dreturn', 'crit', 'critdamage', 'output', 'incdmgamp', 'stun', 'explosion', 'blast', 'breaks', 'mp_reduction']);
const SIGNED_STATS = new Set(['gold', 'luck', 'xp', 'critdamage', 'range', 'speed', 'output', 'mp_cost']);
const GRADES = ['', 'Vysoký', 'Vzácný', 'Legendární', 'Exaltovaný'];
const DAMAGE_TYPES = { physical: 'Fyzické', magical: 'Magické', pure: 'Čisté' };
function statValue(key, value) {
  return `${SIGNED_STATS.has(key) && value > 0 ? '+' : ''}${decimal(value)}${PERCENT_STATS.has(key) ? ' %' : ''}`;
}
// "Lucky Helmet +7" like the game; specialTitle is a known title, special the raw key.
function itemFullName(item) {
  return `${item.specialTitle || (item.special ? item.special : '')} ${item.title}${item.level ? ` +${item.level}` : ''}`.trim();
}
function itemTooltip(item) {
  const lines = [`${itemFullName(item)}${item.quantity > 1 ? ` · ${number(item.quantity)} ks` : ''}${item.locked ? ' · zamčeno' : ''}`];
  if (item.description) lines.push(item.description);
  for (const [key, value] of item.stats || []) lines.push(`${STAT_LABELS[key] || key}: ${statValue(key, value)}`);
  for (const [key, value] of item.gives || []) lines.push(`Obnoví ${key.toUpperCase()}: ${value > 0 ? '+' : ''}${number(value)}`);
  if (item.stat && !item.stats) lines.push(`Stat: ${item.stat}`);
  lines.push('Klikni pro detail');
  return lines.join('\n');
}
let inventoryItems = [];
function itemTile(item, label = '') {
  if (!item) return `<div class="item-tile empty-slot">${label ? `<span class="slot-name">${escape(label)}</span>` : ''}</div>`;
  const search = `${item.title} ${item.name} ${item.specialTitle || ''} ${item.description || ''}`.toLowerCase();
  const index = inventoryItems.push({ item, label }) - 1;
  return `<div class="item-tile${item.grade ? ` grade-${item.grade}` : ''}" role="button" tabindex="0" data-item-index="${index}" data-search="${escape(search)}" title="${escape(itemTooltip(item))}">${label ? `<span class="slot-name">${escape(label)}</span>` : ''}${itemIcon(item.icon)}<strong>${escape(item.title)}</strong><span class="item-meta">${item.level !== null ? `<b>+${item.level}</b>` : ''}${item.quantity > 1 ? `<span>×${number(item.quantity)}</span>` : ''}${item.special ? `<em>${escape(item.specialTitle || item.special)}</em>` : ''}${item.locked ? '<span aria-label="zamčeno">🔒</span>' : ''}</span></div>`;
}
function openItem(index) {
  const entry = inventoryItems[index]; if (!entry) return;
  const { item, label } = entry;
  const facts = [
    label && `<span class="meta-chip">${escape(label)}</span>`,
    item.type && `<span class="meta-chip">${escape(item.type)}</span>`,
    item.tier !== null && item.tier !== undefined && `<span class="meta-chip">Tier ${escape(decimal(item.tier))}</span>`,
    item.grade ? `<span class="meta-chip grade-${item.grade}">${escape(GRADES[item.grade])}</span>` : '',
    item.quantity > 1 && `<span class="meta-chip">${number(item.quantity)} ks</span>`,
    item.locked && '<span class="meta-chip">🔒 Zamčeno</span>',
  ].filter(Boolean).join('');
  const rows = (item.stats || []).map(([key, value]) => [STAT_LABELS[key] || key, statValue(key, value)]);
  for (const [key, value] of item.gives || []) rows.push([`Obnoví ${key.toUpperCase()}`, `${value > 0 ? '+' : ''}${number(value)}`]);
  if (item.damageType) rows.push(['Typ poškození', DAMAGE_TYPES[item.damageType] || item.damageType]);
  if (item.ability) rows.push(['Schopnost', `${item.ability.name}${item.ability.chance ? ` · ${decimal(item.ability.chance)} %` : ''}`]);
  if (item.duration) rows.push(['Trvání', `${decimal(item.duration)} h`]);
  if (item.stat && !item.stats?.length) rows.push(['Stat scroll', item.stat]);
  if (item.set) rows.push(['Sada', item.set]);
  if (item.classes?.length) rows.push(['Třídy', item.classes.join(', ')]);
  const known = Array.isArray(item.stats);
  $('item-detail').innerHTML = `<div class="item-detail-head">${itemIcon(item.icon)}<div><h2>${escape(itemFullName(item))}</h2><p class="fine"><code>${escape(item.name)}</code></p></div></div><div class="editing-meta">${facts}</div>${item.description ? `<p class="item-description">${escape(item.description)}</p>` : ''}${rows.length ? `<table class="item-stats"><tbody>${rows.map(([name, value]) => `<tr><th>${escape(name)}</th><td>${escape(value)}</td></tr>`).join('')}</tbody></table>` : `<p class="fine">${known ? 'Předmět nemá žádné staty.' : 'Herní data předmětu nejsou dostupná.'}</p>`}${known && item.stats.length ? '<p class="fine">Staty jsou spočtené z herních dat jako ve hře, bez bonusů vázaných na třídu nebo mapu.</p>' : ''}`;
  if (!$('item-dialog').open) $('item-dialog').showModal();
}
const slotNames = { helmet: 'Helma', chest: 'Hruď', pants: 'Kalhoty', shoes: 'Boty', gloves: 'Rukavice', cape: 'Plášť', mainhand: 'Hlavní ruka', offhand: 'Druhá ruka', amulet: 'Amulet', earring1: 'Náušnice 1', earring2: 'Náušnice 2', ring1: 'Prsten 1', ring2: 'Prsten 2', belt: 'Opasek', orb: 'Orb', elixir: 'Elixír' };
function renderInventory() {
  const data = inventoryData, bank = inventoryTarget === BANK;
  inventoryItems = [];
  const when = data.observedAt || data.retrievedAt;
  const source = data.source === 'live' ? `<span class="meta-chip running">● Živě${data.via ? ` přes ${escape(data.via)}` : ''}</span>` : `<span class="meta-chip draft">Uložený stav účtu${data.observedAt ? ` · ${escape(new Date(data.observedAt).toLocaleString('cs-CZ'))}` : ' · stáří neznámé'}</span>`;
  const head = `<div class="section-head"><div><h2>${bank ? 'Banka účtu' : escape(data.name)}</h2><p>${bank ? '' : `${escape(data.class)} · LVL ${number(data.level)} · `}${number(data.gold)} G</p></div><button class="ghost small-button" data-inventory-reload>↻ Obnovit</button></div><div class="editing-meta">${source}${when && data.source === 'live' ? `<span class="meta-chip">${escape(new Date(when).toLocaleTimeString('cs-CZ'))}</span>` : ''}</div>`;
  let body;
  if (bank) {
    const filled = data.packs.reduce((sum, pack) => sum + pack.items.filter(Boolean).length, 0);
    body = data.packs.length ? `<p class="fine">Trezory: ${number(data.packs.length)} · obsazená místa: ${number(filled)}</p>${data.packs.map(pack => `<h3 class="inventory-section">Trezor ${Number(pack.name.slice(5)) + 1} <small>${escape(pack.name)} · ${pack.items.filter(Boolean).length}/${pack.items.length}</small></h3><div class="item-grid">${pack.items.map(item => itemTile(item)).join('')}</div>`).join('')}` : '<p class="fine">Banka je prázdná.</p>';
  } else {
    const items = [...data.items]; while (items.length < data.size) items.push(null);
    body = `<h3 class="inventory-section">Vybavení</h3><div class="item-grid equipment">${data.equipment.map(e => itemTile(e.item, slotNames[e.slot] || e.slot)).join('') || '<p class="fine">Žádné vybavení.</p>'}</div><h3 class="inventory-section">Inventář <small>${data.items.filter(Boolean).length}/${data.size}</small></h3><div class="item-grid">${items.map(item => itemTile(item)).join('')}</div>`;
  }
  $('inventory-detail').innerHTML = head + body;
  applyInventoryFilter();
}
function applyInventoryFilter() {
  const query = $('inventory-filter').value.trim().toLowerCase();
  for (const tile of $('inventory-detail').querySelectorAll('.item-tile')) tile.classList.toggle('dimmed', !!query && !(tile.dataset.search || '').includes(query));
}

let opened = false;
on('dashboard', offline => {
  if (offline) return;
  renderInventoryTargets();
  if (!opened) { opened = true; ensureOwned(); if (inventoryTarget) loadInventory(); }
  // A live inventory follows the running character.
  else if (inventoryData?.source === 'live') loadInventory(true);
});
on('owned', () => { if (app.dashboard) renderInventoryTargets(); });
on('reset', () => {
  inventoryTarget = null; inventoryData = null; inventoryJson = ''; opened = false;
  $('inventory-detail').innerHTML = '<div class="empty"><h2>Vyber postavu nebo banku.</h2><p>Uvidíš vybavení, inventář a zlato.</p></div>';
  $('inventory-targets').replaceChildren(); delete $('inventory-targets').dataset.html;
});
$('inventory-filter').addEventListener('input', applyInventoryFilter);
$('inventory-targets').addEventListener('click', event => {
  const button = event.target.closest('[data-inventory]'); if (button) selectTarget(button.dataset.inventory);
});
$('inventory-detail').addEventListener('click', event => {
  if (event.target.closest('[data-inventory-reload]')) return loadInventory();
  const tile = event.target.closest('[data-item-index]'); if (tile) openItem(Number(tile.dataset.itemIndex));
});
$('inventory-detail').addEventListener('keydown', event => {
  const tile = event.target.closest('[data-item-index]');
  if (tile && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openItem(Number(tile.dataset.itemIndex)); }
});
$('close-item').addEventListener('click', () => $('item-dialog').close());

await boot();
