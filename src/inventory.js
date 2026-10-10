const ITEM_NAME = /^[a-zA-Z0-9_]{1,64}$/;
const SLOT = /^[a-zA-Z0-9_]{1,32}$/;
const PACK = /^items[0-9]{1,2}$/;
const count = (value, min) => Number.isSafeInteger(Number(value)) && Number(value) >= min ? Number(value) : null;
// Equipment slots in the order the game shows them; unknown slots follow.
const SLOT_ORDER = ['helmet', 'chest', 'pants', 'shoes', 'gloves', 'cape', 'mainhand', 'offhand', 'amulet', 'earring1', 'earring2', 'ring1', 'ring2', 'belt', 'orb', 'elixir'];

// Only whitelisted fields leave the server; game items can carry arbitrary nested data.
export function itemView(item, names = {}) {
  if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !ITEM_NAME.test(item.name) || item.name === 'placeholder') return null;
  const level = count(item.level, 0), known = Object.hasOwn(names, item.name) ? names[item.name] : null;
  return {
    name: item.name, title: known ? known.name : item.name, icon: known?.icon || null,
    level, quantity: count(item.q, 1) || 1,
    locked: !!(item.l || item.b), special: typeof item.p === 'string' && /^[a-z0-9_]{1,24}$/i.test(item.p) ? item.p : null,
    stat: typeof item.stat_type === 'string' && /^[a-z0-9_]{1,24}$/i.test(item.stat_type) ? item.stat_type : null,
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
