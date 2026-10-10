const ITEM_NAME = /^[a-zA-Z0-9_]{1,64}$/;
const SLOT = /^[a-zA-Z0-9_]{1,32}$/;
const PACK = /^items[0-9]{1,2}$/;
const count = (value, min) => Number.isSafeInteger(Number(value)) && Number(value) >= min ? Number(value) : null;
// Equipment slots in the order the game shows them; unknown slots follow.
const SLOT_ORDER = ['helmet', 'chest', 'pants', 'shoes', 'gloves', 'cape', 'mainhand', 'offhand', 'amulet', 'earring1', 'earring2', 'ring1', 'ring2', 'belt', 'orb', 'elixir'];
// Item stats in the order the game's item window lists them; attr0/attr1 only parametrize an ability.
export const ITEM_STATS = ['gold', 'luck', 'xp', 'lifesteal', 'manasteal', 'evasion', 'miss', 'reflection', 'dreturn', 'crit', 'critdamage', 'attack', 'range', 'hp', 'str', 'int', 'dex', 'vit', 'for', 'mp', 'mp_cost', 'mp_reduction', 'stat', 'armor', 'apiercing', 'rpiercing', 'resistance', 'pnresistance', 'firesistance', 'fzresistance', 'phresistance', 'stresistance', 'speed', 'frequency', 'output', 'incdmgamp', 'stun', 'explosion', 'blast', 'breaks', 'charisma', 'awesomeness', 'bling', 'cuteness', 'courage', 'mcourage', 'pcourage', 'attr0', 'attr1'];
const UNROUNDED = new Set(['evasion', 'miss', 'reflection', 'dreturn', 'lifesteal', 'manasteal', 'attr0', 'attr1', 'crit', 'critdamage', 'breaks']);
// How much of an item's generic "stat" a stat scroll (item.stat_type) turns into the chosen stat.
const STAT_SCROLL = { gold: 0.5, luck: 1, xp: 0.5, int: 1, str: 1, dex: 1, vit: 1, for: 1, armor: 2.25, resistance: 2.25, speed: 0.325, evasion: 0.325, reflection: 0.15, lifesteal: 0.15, manasteal: 0.04, rpiercing: 2.25, apiercing: 2.25, crit: 0.125, dreturn: 0.5, frequency: 0.325, mp_cost: -0.6, output: 0.175 };
const DOUBLEHAND = ['axe', 'basher', 'great_staff'];
const UPGRADE_STEP = { 7: 1.25, 8: 1.5, 9: 2, 10: 3, 11: 1.25, 12: 1.25 }, COMPOUND_STEP = { 5: 1.25, 6: 1.5, 7: 2 };

// Mirrors the game's calculate_item_properties without class- or map-only bonuses; "glitched" items get a random +1 the game rolls itself.
function itemProperties(def, item) {
  const prop = Object.fromEntries(ITEM_STATS.map(key => [key, 0])), base = def.stats || {};
  const add = (stats, factor = 1) => { for (const [key, value] of Object.entries(stats || {})) if (Object.hasOwn(prop, key)) prop[key] += value * factor; };
  if (item.p === 'shiny') {
    if (base.attack) prop.attack += DOUBLEHAND.includes(def.wtype) ? 7 : 4;
    else if (base.stat) prop.stat += 2;
    else if (base.armor) { prop.armor += 12; prop.resistance += 10; }
    else { prop.dex += 1; prop.int += 1; prop.str += 1; }
  } else if (item.p && item.p !== 'glitched' && def.titles && Object.hasOwn(def.titles, item.p)) add(def.titles[item.p].stats);
  const steps = def.upgrade || def.compound, level = item.level || 0;
  if (steps) for (let i = 1; i <= level; i++) {
    const factor = def.upgrade ? UPGRADE_STEP[i] || 1 : i >= 8 ? 3 : COMPOUND_STEP[i] || 1;
    for (const [key, value] of Object.entries(steps)) {
      if (!Object.hasOwn(prop, key)) continue;
      prop[key] += key === 'stat' ? Math.round(value * factor) : value * factor;
      if (key === 'stat' && i >= 7) prop.stat++;
    }
  }
  if (level === 10 && prop.stat && def.tier >= 3) prop.stat += 2;
  add(base);
  if (item.p === 'legacy') for (const [key, value] of Object.entries(def.legacy || {})) if (value !== null) prop[key] += value;
  for (const key of ITEM_STATS) if (!UNROUNDED.has(key)) prop[key] = Math.round(prop[key]);
  if (base.stat && Object.hasOwn(STAT_SCROLL, item.stat_type)) { prop[item.stat_type] += prop.stat * STAT_SCROLL[item.stat_type]; prop.stat = 0; }
  return prop;
}
const twoDecimals = value => Math.round(value * 100) / 100;
export function itemStats(def, item) {
  const prop = itemProperties(def, item);
  return ITEM_STATS.filter(key => prop[key] && !key.startsWith('attr')).map(key => [key, twoDecimals(prop[key])]);
}
// 0 normal, 1 high, 2 rare, 3 legendary, 4 exalted; only upgradable or compoundable items have a grade.
function itemGrade(def, level) {
  if (!def.upgrade && !def.compound) return 0;
  const grades = def.grades || [9, 10, 11, 12];
  return grades.filter(g => (level || 0) >= g).length;
}

// Only whitelisted fields leave the server; game items can carry arbitrary nested data.
export function itemView(item, names = {}) {
  if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !ITEM_NAME.test(item.name) || item.name === 'placeholder') return null;
  const level = count(item.level, 0), known = Object.hasOwn(names, item.name) ? names[item.name] : null;
  return {
    name: item.name, title: known ? known.name : item.name, icon: known?.icon || null,
    level, quantity: count(item.q, 1) || 1,
    locked: !!(item.l || item.b), special: typeof item.p === 'string' && /^[a-z0-9_]{1,24}$/i.test(item.p) ? item.p : null,
    stat: typeof item.stat_type === 'string' && /^[a-z0-9_]{1,24}$/i.test(item.stat_type) ? item.stat_type : null,
    ...(known?.stats ? itemDetailView(known, item, level) : {}),
  };
}
// Description and computed stats for an item whose definition data.js provided.
function itemDetailView(def, item, level) {
  const special = typeof item.p === 'string' && def.titles && Object.hasOwn(def.titles, item.p) ? def.titles[item.p].title : null;
  const legacy = item.p === 'legacy' ? def.legacy || {} : {}, prop = itemProperties(def, { level, p: item.p, stat_type: item.stat_type });
  return {
    type: def.type || null, description: def.explanation, specialTitle: special, tier: def.tier, damageType: def.damageType,
    stats: ITEM_STATS.filter(key => prop[key] && !key.startsWith('attr')).map(key => [key, twoDecimals(prop[key])]), grade: itemGrade(def, level),
    gives: def.gives, duration: def.duration, classes: legacy.class === null ? [] : def.classes, set: legacy.set === null ? null : def.set,
    ability: def.ability ? { name: def.ability, chance: prop.attr0 ? twoDecimals(prop.attr0) : null } : null,
  };
}
export function itemsView(items, names, limit = 168) {
  return (Array.isArray(items) ? items.slice(0, limit) : []).map(item => itemView(item, names));
}
export function equipmentView(slots, names) {
  if (!slots || typeof slots !== 'object') return [];
  const keys = Object.keys(slots).filter(slot => SLOT.test(slot) && !slot.startsWith('trade'));
  keys.sort((a, b) => (SLOT_ORDER.indexOf(a) + 1 || 99) - (SLOT_ORDER.indexOf(b) + 1 || 99));
  return keys.map(slot => ({ slot, item: itemView(slots[slot], names) }));
}
export function packsView(bank, names) {
  if (!bank || typeof bank !== 'object') return [];
  return Object.keys(bank).filter(pack => PACK.test(pack) && Array.isArray(bank[pack]))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .map(pack => ({ name: pack, items: itemsView(bank[pack], names, 64) }));
}
export const goldOf = value => count(value, 0) ?? 0;

// Groups the items of every source (character inventories and equipment, the bank) by item, level and prefix,
// with where each group lies. Sources are already sanitized views; a source that failed only reports its error.
export function aggregateItems(sources, names = {}) {
  const groups = new Map();
  const add = (item, owner, place) => {
    if (!item) return;
    const key = `${item.name}|${item.level ?? ''}|${item.special ?? ''}`;
    const def = Object.hasOwn(names, item.name) ? names[item.name] : null;
    let group = groups.get(key);
    if (!group) {
      group = {
        key, name: item.name, title: item.title, icon: item.icon, level: item.level, special: item.special, specialTitle: item.specialTitle ?? null,
        grade: item.grade ?? 0, type: item.type ?? null, description: item.description ?? null, stats: item.stats ?? [],
        upgrade: def?.upgrade ? 'upgrade' : def?.compound ? 'compound' : null, total: 0, locations: [],
      };
      groups.set(key, group);
    }
    group.total += item.quantity;
    const location = group.locations.find(l => l.owner === owner && l.place === place && l.locked === item.locked);
    if (location) location.count += item.quantity; else group.locations.push({ owner, place, locked: item.locked, count: item.quantity });
  };
  const summary = sources.map(source => {
    if (source.error) return { kind: source.kind, name: source.name, error: source.error };
    if (source.kind === 'bank') for (const pack of source.packs) for (const item of pack.items) add(item, null, 'bank');
    else {
      for (const { item } of source.equipment) add(item, source.name, 'equipment');
      for (const item of source.items) add(item, source.name, 'inventory');
    }
    return { kind: source.kind, name: source.name, class: source.class ?? null, level: source.level ?? null, source: source.source, observedAt: source.observedAt ?? source.retrievedAt ?? null, gold: source.gold };
  });
  const items = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.level ?? -1) - (b.level ?? -1));
  return { sources: summary, items, gold: summary.reduce((sum, s) => sum + (s.gold || 0), 0) };
}
