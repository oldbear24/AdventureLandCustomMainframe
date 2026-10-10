import { GAME_ORIGIN } from './runtime.js';
import { conditionDefinitions } from './conditions.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
export const MAP_NAME = /^[a-zA-Z0-9_]{1,40}$/;
const ITEM_NAME = /^[a-zA-Z0-9_]{1,64}$/;
const MAX_SIZE = 30 * 1024 * 1024;
const REFRESH = 6 * 60 * 60 * 1000;
const finite = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
const text = (value, fallback) => typeof value === 'string' && value.length <= 80 ? value : fallback;
const point = (x, y) => finite(x) !== null && finite(y) !== null;

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

// Public game definitions (data.js) give map geometry and item names without any running character.
export class GameData {
  constructor(request = fetch) {
    this.request = request; this.data = null; this.loadedAt = 0; this.loading = null; this.maps = new Map();
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
    const items = {};
    for (const [key, item] of Object.entries(G.items)) if (ITEM_NAME.test(key)) items[key] = { name: text(item?.name, key), type: text(item?.type, '') };
    const maps = Object.entries(G.maps).filter(([name, map]) => MAP_NAME.test(name) && map && !map.ignore && (G.geometry[map.key] || G.geometry[name]))
      .map(([name, map]) => ({ name, title: text(map.name, name) })).sort((a, b) => a.title.localeCompare(b.title));
    return { G, items, maps, conditions: conditionDefinitions(G.conditions), version: finite(G.version) };
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
  // Display names are optional: an unreachable data.js must not hide an inventory.
  async itemNames() {
    try { return (await this.load()).items; } catch { return {}; }
  }
  async conditions() { const data = await this.load(); return { version: data.version, conditions: data.conditions }; }
}
