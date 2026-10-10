import { GAME_ORIGIN } from './runtime.js';
import { ITEM_STATS } from './inventory.js';
import { BOSSES, EVENTS } from './server-events.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
export const MAP_NAME = /^[a-zA-Z0-9_]{1,40}$/;
const ITEM_NAME = /^[a-zA-Z0-9_]{1,64}$/;
const SHEET = /^[a-zA-Z0-9_]{1,40}$/;
const SHEET_FILE = /^\/images\/[a-zA-Z0-9_/.-]{1,160}\.png(\?v=[a-zA-Z0-9]{1,16})?$/;
const MAX_SIZE = 30 * 1024 * 1024;
const MAX_SHEET_SIZE = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REFRESH = 6 * 60 * 60 * 1000;
const finite = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
const text = (value, fallback) => typeof value === 'string' && value.length <= 80 ? value : fallback;
const point = (x, y) => finite(x) !== null && finite(y) !== null;
const NAMES = list => Array.isArray(list) ? list.filter(c => typeof c === 'string' && /^[a-z]{1,24}$/.test(c)).slice(0, 12) : [];
// Only numeric item properties the game turns into stats; everything else in G.items stays on the server.
const numbers = source => {
  const out = {};
  if (source && typeof source === 'object') for (const key of ITEM_STATS) if (typeof source[key] === 'number' && Number.isFinite(source[key])) out[key] = source[key];
  return out;
};

// Reduces one map to what the panel draws: walls, monster zones, NPCs and doors.
function compactMap(G, name) {
  const map = G.maps[name], geometry = G.geometry?.[map.key] || G.geometry?.[name];
  if (!geometry || ![geometry.min_x, geometry.max_x, geometry.min_y, geometry.max_y].every(v => finite(v) !== null)) return null;
  const lines = list => (Array.isArray(list) ? list : []).filter(l => Array.isArray(l) && l.slice(0, 3).every(v => finite(v) !== null)).map(l => l.slice(0, 3).map(finite));
  const monsters = [];
  for (const zone of Array.isArray(map.monsters) ? map.monsters : []) {
    if (typeof zone?.type !== 'string') continue;
    const boxes = Array.isArray(zone.boundary) ? [zone.boundary] : (Array.isArray(zone.boundaries) ? zone.boundaries.filter(b => b?.[0] === name).map(b => b.slice(1)) : []);
    for (const box of boxes) {
      if (box.length < 4 || !box.slice(0, 4).every(v => finite(v) !== null)) continue;
      monsters.push({ type: zone.type, name: text(G.monsters?.[zone.type]?.name, zone.type), count: finite(zone.count) || 0, box: box.slice(0, 4).map(finite) });
    }
  }
  const npcs = (Array.isArray(map.npcs) ? map.npcs : []).filter(n => Array.isArray(n?.position) && point(n.position[0], n.position[1]))
    .map(n => ({ id: String(n.id), name: text(n.name, text(G.npcs?.[n.id]?.name, String(n.id))), x: finite(n.position[0]), y: finite(n.position[1]) }));
  const doors = (Array.isArray(map.doors) ? map.doors : []).filter(d => Array.isArray(d) && d.slice(0, 4).every(v => finite(v) !== null) && typeof d[4] === 'string')
    .map(d => ({ x: finite(d[0]), y: finite(d[1]), w: finite(d[2]), h: finite(d[3]), to: d[4], title: text(G.maps[d[4]]?.name, d[4]) }));
  return {
    name, title: text(map.name, name),
    bounds: { minX: finite(geometry.min_x), maxX: finite(geometry.max_x), minY: finite(geometry.min_y), maxY: finite(geometry.max_y) },
    xLines: lines(geometry.x_lines), yLines: lines(geometry.y_lines), monsters, npcs, doors,
  };
}

// Item icon sheets (imagesets) are grids of square tiles; only well-formed local PNG paths are kept.
function iconSheets(G) {
  const sheets = {};
  for (const [key, set] of Object.entries(G.imagesets || {})) {
    const size = finite(set?.size), columns = finite(set?.columns), rows = finite(set?.rows);
    if (!SHEET.test(key) || typeof set.file !== 'string' || !SHEET_FILE.test(set.file) || set.file.includes('..')) continue;
    if (size > 0 && size <= 64 && columns > 0 && columns <= 256 && rows > 0 && rows <= 512) sheets[key] = { file: set.file, size, columns, rows };
  }
  return sheets;
}
// G.positions maps an item (or its skin) to [sheet, column, row]; an empty sheet name means the default pack_20.
function iconOf(G, sheets, key, item) {
  const position = G.positions?.[typeof item?.skin === 'string' ? item.skin : key];
  if (!Array.isArray(position) || position.length !== 3 || typeof position[0] !== 'string') return null;
  const sheet = position[0] || 'pack_20', set = Object.hasOwn(sheets, sheet) ? sheets[sheet] : null;
  const column = finite(position[1]), row = finite(position[2]);
  if (!set || column === null || row === null || column < 0 || row < 0 || column >= set.columns || row >= set.rows) return null;
  return { sheet, x: column * set.size, y: row * set.size, size: set.size, width: set.columns * set.size, height: set.rows * set.size };
}

// Passive item abilities the game client names itself (html.js render_item); they are not in G.skills.
const ITEM_ABILITIES = {
  bash: 'Bash', freeze: 'Freeze', poison: 'Poison', burn: 'Burn', weave: 'Weave', secondchance: 'Second Chance', sugarrush: 'Sugar Rush', charm: 'Charm',
  restore_mp: 'Restore MP', petrify: 'Petrify', hex: 'Hex', shatter: 'Shatter', sunder: 'Sunder', frenzy: 'Primal Frenzy',
};
const abilityName = (G, key) => Object.hasOwn(ITEM_ABILITIES, key) ? ITEM_ABILITIES[key]
  : text(G.skills && Object.hasOwn(G.skills, key) ? G.skills[key]?.name : null, key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));

// What the panel needs to describe an item and compute its stats the way the game does (calculate_item_properties).
function itemDetails(G, key, item, titles) {
  const ability = typeof item?.ability === 'string' && /^[a-z0-9_]{1,32}$/i.test(item.ability) ? item.ability : null;
  const legacy = {};
  if (item?.legacy && typeof item.legacy === 'object') for (const [stat, value] of Object.entries(item.legacy)) if (value === null ? ['class', 'set'].includes(stat) : ITEM_STATS.includes(stat) && Number.isFinite(value)) legacy[stat] = value;
  return {
    name: text(item?.name, key), type: text(item?.type, ''),
    explanation: typeof item?.explanation === 'string' && item.explanation.length <= 400 ? item.explanation : null,
    tier: Number.isFinite(item?.tier) ? item.tier : null, wtype: text(item?.wtype, null),
    damageType: ['physical', 'magical', 'pure'].includes(item?.damage_type) ? item.damage_type : null,
    stats: numbers(item), upgrade: item?.upgrade ? numbers(item.upgrade) : null, compound: !item?.upgrade && item?.compound ? numbers(item.compound) : null,
    grades: Array.isArray(item?.grades) && item.grades.length === 4 && item.grades.every(Number.isFinite) ? item.grades : null,
    gives: Array.isArray(item?.gives) ? item.gives.filter(g => Array.isArray(g) && ['hp', 'mp'].includes(g[0]) && Number.isFinite(g[1])).map(g => [g[0], g[1]]) : [],
    duration: Number.isFinite(item?.duration) ? item.duration : null,
    classes: NAMES(item?.class), set: typeof item?.set === 'string' ? text(G.sets?.[item.set]?.name, item.set) : null,
    ability: ability ? abilityName(G, ability) : null, legacy, titles,
  };
}

// Public game definitions (data.js) give map geometry and item names without any running character.
export class GameData {
  constructor(request = fetch) {
    this.request = request; this.data = null; this.loadedAt = 0; this.loading = null; this.maps = new Map(); this.sheets = new Map();
  }
  async fetchData() {
    let body;
    try {
      const response = await this.request(`${GAME_ORIGIN}/data.js`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(String(response.status));
      body = await response.text();
    } catch { throw failure(502, 'Herní data (mapy a předměty) se nepodařilo stáhnout z Adventure Land.'); }
    if (body.length > MAX_SIZE) throw failure(502, 'Herní data jsou neočekávaně velká.');
    let G;
    try { G = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)); }
    catch { throw failure(502, 'Herní data mají neočekávaný formát.'); }
    if (!G?.maps || !G?.geometry || !G?.items) throw failure(502, 'Herní data mají neočekávaný formát.');
    const sheets = iconSheets(G), items = {}, titles = {};
    for (const [key, title] of Object.entries(G.titles || {})) if (ITEM_NAME.test(key) && title && typeof title === 'object') titles[key] = { title: text(title.title, key), stats: numbers(title) };
    // Every item shares the one titles table; it resolves an item's prefix (item.p) such as Lucky or Fast.
    for (const [key, item] of Object.entries(G.items)) if (ITEM_NAME.test(key)) items[key] = { ...itemDetails(G, key, item, titles), icon: iconOf(G, sheets, key, item) };
    const maps = Object.entries(G.maps).filter(([name, map]) => MAP_NAME.test(name) && map && !map.ignore && (G.geometry[map.key] || G.geometry[name]))
      .map(([name, map]) => ({ name, title: text(map.name, name) })).sort((a, b) => a.title.localeCompare(b.title));
    // Every boss and event a server can report, for the event notification settings.
    const eventKeys = new Set([...BOSSES, ...EVENTS, ...Object.keys(G.events || {}).filter(key => /^[a-z0-9_]{1,32}$/.test(key) && !G.events[key]?.disabled && key !== 'dreams')]);
    const events = [...eventKeys].map(key => ({ key, title: text(G.events?.[key]?.name, text(G.monsters?.[key]?.name, key)), kind: BOSSES.includes(key) ? 'boss' : 'event' }))
      .sort((a, b) => (a.kind === 'boss' ? 0 : 1) - (b.kind === 'boss' ? 0 : 1) || a.title.localeCompare(b.title));
    return { G, items, maps, sheets, events, version: finite(G.version) };
  }
  // Refreshes at most every 6 hours; a failed refresh keeps serving the previous copy.
  async load() {
    if (this.data && Date.now() - this.loadedAt < REFRESH) return this.data;
    this.loading ||= this.fetchData().then(data => { this.data = data; this.loadedAt = Date.now(); this.maps.clear(); return data; })
      .catch(error => { if (this.data) { this.loadedAt = Date.now() - REFRESH + 10 * 60_000; return this.data; } throw error; })
      .finally(() => { this.loading = null; });
    return this.loading;
  }
  async mapList() { const data = await this.load(); return { version: data.version, maps: data.maps }; }
  async map(name) {
    if (!MAP_NAME.test(name)) throw failure(400, 'Neplatný název mapy.');
    const data = await this.load();
    if (!this.maps.has(name)) {
      if (!Object.hasOwn(data.G.maps, name)) throw failure(404, 'Mapa neexistuje.');
      const map = compactMap(data.G, name);
      if (!map) throw failure(404, 'Mapa nemá geometrii.');
      this.maps.set(name, map);
    }
    return this.maps.get(name);
  }
  // Icon sheets are fetched once per file version and kept in memory; a failed download is retried on the next request.
  async sheet(name) {
    if (!SHEET.test(name)) throw failure(400, 'Neplatný název obrázků.');
    const data = await this.load();
    const set = Object.hasOwn(data.sheets, name) ? data.sheets[name] : null;
    if (!set) throw failure(404, 'Obrázky předmětů neexistují.');
    const cached = this.sheets.get(name);
    if (cached?.file === set.file) return cached.body;
    const body = this.fetchSheet(set.file).catch(error => { if (this.sheets.get(name)?.body === body) this.sheets.delete(name); throw error; });
    this.sheets.set(name, { file: set.file, body });
    return body;
  }
  async fetchSheet(file) {
    let body;
    try {
      const response = await this.request(new URL(file, GAME_ORIGIN).href, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(String(response.status));
      body = Buffer.from(await response.arrayBuffer());
    } catch { throw failure(502, 'Obrázky předmětů se nepodařilo stáhnout z Adventure Land.'); }
    if (body.length > MAX_SHEET_SIZE || !body.subarray(0, 8).equals(PNG)) throw failure(502, 'Obrázky předmětů mají neočekávaný formát.');
    return body;
  }
  async eventCatalog() { return (await this.load()).events; }
  // Display names are optional: an unreachable data.js must not hide an inventory.
  async itemNames() {
    try { return (await this.load()).items; } catch { return {}; }
  }
}
