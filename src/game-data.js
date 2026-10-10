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

// Character sprite sheets (G.sprites) cut like the game's precompute_image_positions (html.js): a body cell holds
// 3 frames × 4 directions, heads, hair and hats hold one frame per direction.
const ONE_FRAME = ['v_animation', 'head', 'hair', 'hat', 's_wings', 'face', 'makeup', 'beard'];
const CX_SLOTS = { armor: 'skin', body: 'skin', character: 'skin', face: 'face', makeup: 'makeup', a_makeup: 'makeup', beard: 'chin', mask: 'chin', tail: 'tail', s_wings: 'back', wings: 'back', hat: 'hat', a_hat: 'hat', head: 'head', hair: 'hair', gravestone: 'gravestone' };
export const LOOK_KEY = /^[a-zA-Z0-9_]{1,40}$/;
const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function spriteIndex(G) {
  const sprites = {}, spriteSheets = {};
  for (const [key, def] of Object.entries(G.sprites || {})) {
    if (!SHEET.test(key) || !def || def.skip || typeof def.file !== 'string' || !SHEET_FILE.test(def.file) || def.file.includes('..') || !Array.isArray(def.matrix)) continue;
    const columns = finite(def.columns), rows = finite(def.rows), image = G.images?.[def.file.split('?')[0]];
    const width = finite(image?.width) || finite(def.width) || 312, height = finite(image?.height) || finite(def.height) || 288;
    if (!(columns > 0 && columns <= 64 && rows > 0 && rows <= 64 && width <= 4096 && height <= 4096)) continue;
    const type = typeof def.type === 'string' ? def.type : 'full';
    let rowFrames = 4, columnFrames = 3;
    if (type === 'animation') rowFrames = 1;
    if (type === 'tail') columnFrames = 4;
    if (ONE_FRAME.includes(type)) columnFrames = 1;
    if (['a_makeup', 'a_hat'].includes(type)) columnFrames = finite(def.frames) || 3;
    if (type === 'head' && finite(def.frames) > 0) columnFrames = finite(def.frames);
    if (['emblem', 'gravestone'].includes(type)) rowFrames = columnFrames = 1;
    spriteSheets[key] = { file: def.file };
    def.matrix.forEach((row, i) => (Array.isArray(row) ? row : []).forEach((name, j) => {
      if (typeof name !== 'string' || !LOOK_KEY.test(name)) return;
      const size = typeof def.size === 'string' ? def.size : 'normal';
      sprites[name] = {
        sheet: key, sheetWidth: width, sheetHeight: height, x: j * width / columns + amount(G.dimensions?.[name]?.[2]), y: i * height / rows,
        width: width / (columns * columnFrames), height: height / (rows * rowFrames), columnFrames, type,
        size, sizeUpper: size + (G.cosmetics?.prop?.[name]?.includes?.('slender') ? 'slender' : ''),
      };
    }));
  }
  return { sprites, spriteSheets };
}
// One layer of a character, as the game's sprite_image places it: a cropped frame anchored to the bottom of the box.
function spriteLayer(G, sprites, name, args) {
  if (!Object.hasOwn(sprites, name)) name = 'naked';
  const s = sprites[name];
  if (!s) return null;
  const scale = args.scale, rheight = args.rheight || 0, p = args.p || 0, dims = G.dimensions?.[name];
  const width = Array.isArray(dims) ? amount(dims[0]) : s.width, height = Array.isArray(dims) ? amount(dims[1]) : s.height;
  const left = (args.cwidth - width * scale) / 2 + (args.x || 0) * scale, frameShift = s.columnFrames === 1 ? width : 0;
  return {
    sheet: s.sheet, left, bottom: (p + rheight) * scale, width: width * scale, height: (height - rheight) * scale,
    imageX: (-s.x - s.width + frameShift - (s.width - width + (args.xDisp || 0)) / 2) * scale, imageY: (-s.y - s.height + height) * scale,
    imageWidth: s.sheetWidth * scale, imageHeight: s.sheetHeight * scale,
  };
}
// The game's html.js sprite(): a body (full sprite, armor or body) with skin, head, hair, face, beard, hat and back cosmetics, facing down.
function characterLayers(G, sprites, look, box) {
  let name = look.skin;
  if (!Object.hasOwn(sprites, name)) return null;
  const C = G.cosmetics || {}, T = n => Object.hasOwn(sprites, n) ? sprites[n].type : undefined;
  const cx = {};
  for (const [place, id] of Object.entries(look.cx || {})) {
    if (!id || !Object.hasOwn(sprites, id)) continue;
    if (place === 'upper' ? !['body', 'armor'].includes(T(id)) : CX_SLOTS[T(id)] !== place) continue;
    cx[place] = id;
  }
  const s = sprites[name], props = new Set();
  for (const id of [name, ...Object.values(cx)]) for (const p of Array.isArray(C.prop?.[id]) ? C.prop[id] : []) props.add(p);
  const bodyType = ['armor', 'body', 'character'].includes(s.type) ? s.type : 'full';
  if (bodyType !== 'full' && bodyType !== 'character') cx.head ||= 'makeup117';
  else { delete cx.head; delete cx.hair; }
  if (props.has('no_hair')) delete cx.hair;
  if (cx.upper && (bodyType === 'full' || bodyType === 'character' || T(cx.upper) !== 'armor' || sprites[cx.upper].sizeUpper !== s.sizeUpper)) delete cx.upper;
  if (cx.hat && props.has('no_hat')) delete cx.hat;
  const headDy = { large: 2, tall: 1, normal: 0, small: -1, xsmall: -3, xxsmall: -4 }[s.size] ?? 0;
  const cosmeticHeadY = amount(C.head_y?.[name]);
  const headDh = amount(C.head?.[cx.head]?.[3]);
  const headY = amount(C.default_head_place) - cosmeticHeadY + headDy;
  const hairY = amount(C.default_hair_place) - cosmeticHeadY + amount(C.hair?.[cx.hair]?.[0]) + headDh + headDy;
  const hatY = amount(C.default_hat_place) - cosmeticHeadY + amount(C.hair?.[cx.hair]?.[1]) + headDy + amount(C.hat?.[cx.hat]) + headDh;
  let skin = null;
  if (cx.head && bodyType === 'armor') {
    const heads = Array.isArray(C.head?.[cx.head]) ? C.head[cx.head] : [];
    skin = { small: heads[0] || 'sskin1a', normal: heads[1] || 'mskin1a', tall: heads[1] || 'mskin1a', large: heads[2] || 'lskin1a' }[s.size] || null;
  }
  const xDisp = s.width % 2 ? 0 : -0.5, base = { cwidth: box.width, scale: box.scale };
  const rxDisp = Array.isArray(G.dimensions?.[name]) && G.dimensions[name][3] ? -amount(G.dimensions[name][3]) * box.scale : 0;
  const hiddenHead = !!C.prop?.[name]?.includes?.('covers');
  const layers = [];
  const add = (id, args) => { if (id) { const layer = spriteLayer(G, sprites, id, { ...base, ...args }); if (layer) layers.push(layer); } };
  if (cx.head && hiddenHead) add(cx.head, { x: xDisp, p: headY });
  if (cx.back) add(cx.back, { x: xDisp + (T(cx.back) === 'wings' ? -2.5 : 0) });
  if (skin) add(skin, {});
  add(name, { xDisp: rxDisp + xDisp });
  if (cx.upper) add(cx.upper, { rheight: 8 });
  if (cx.head && !hiddenHead) add(cx.head, { x: xDisp, p: headY });
  if (cx.hair) add(cx.hair, { x: xDisp, p: hairY });
  if (cx.face) add(cx.face, { x: xDisp, p: headY + amount(C.default_face_position) });
  if (cx.chin) add(cx.chin, { x: xDisp, p: headY + amount(C.default_beard_position) });
  if (cx.tail) add(cx.tail, { p: 0 });
  if (cx.hat) add(cx.hat, { x: xDisp, p: hatY });
  if (cx.makeup) add(cx.makeup, { x: xDisp, p: headY + amount(C.default_makeup_position) });
  return layers.length ? { width: box.width, height: box.height, layers } : null;
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

// Monster stats, base gold, drops and spawn maps for the farming table. Hidden (unlisted) monsters are left out.
function monsterTable(G, items) {
  const spawns = new Map();
  for (const [name, map] of Object.entries(G.maps)) {
    if (!MAP_NAME.test(name) || !map || map.ignore) continue;
    for (const zone of Array.isArray(map.monsters) ? map.monsters : []) {
      if (typeof zone?.type !== 'string') continue;
      const list = spawns.get(zone.type) || [];
      const existing = list.find(s => s.map === name);
      if (existing) existing.count += finite(zone.count) || 0;
      else list.push({ map: name, title: text(map.name, name), count: finite(zone.count) || 0 });
      spawns.set(zone.type, list);
    }
  }
  const number = value => Number.isFinite(value) ? value : null;
  return Object.entries(G.monsters || {}).filter(([key, m]) => MAP_NAME.test(key) && m && typeof m === 'object' && !m.unlist && Number.isFinite(m.hp) && m.hp > 0).map(([key, m]) => {
    const drops = (Array.isArray(G.drops?.monsters?.[key]) ? G.drops.monsters[key] : [])
      .filter(d => Array.isArray(d) && Number.isFinite(d[0]) && d[0] > 0 && typeof d[1] === 'string' && ITEM_NAME.test(d[1]))
      .map(d => ({ chance: d[0], item: d[1], title: items[d[1]]?.name || d[1], icon: items[d[1]]?.icon || null, quantity: Number.isInteger(d[2]) && d[2] > 1 ? d[2] : null }))
      .sort((a, b) => b.chance - a.chance).slice(0, 20);
    return {
      key, name: text(m.name, key), hp: number(m.hp), xp: number(m.xp), gold: number(G.monster_gold?.[key]), attack: number(m.attack),
      damageType: ['physical', 'magical', 'pure'].includes(m.damage_type) ? m.damage_type : null, frequency: number(m.frequency), speed: number(m.speed), range: number(m.range),
      armor: number(m.armor) ?? 0, resistance: number(m.resistance) ?? 0, evasion: number(m.evasion) ?? 0, aggro: number(m.aggro), mp: number(m.mp),
      cooperative: !!m.cooperative, boss: BOSSES.includes(key) || !!m.special, poisonous: !!m.poisonous, spawns: spawns.get(key) || [], drops,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

// Public game definitions (data.js) give map geometry and item names without any running character.
export class GameData {
  constructor(request = fetch) {
    this.request = request; this.data = null; this.loadedAt = 0; this.loading = null; this.maps = new Map(); this.sheets = new Map(); this.looks = new Map();
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
    const monsters = Object.entries(G.monsters || {}).filter(([key, monster]) => ITEM_NAME.test(key) && monster && typeof monster === 'object')
      .map(([key, monster]) => ({ key, name: text(monster.name, key) }));
    return { G, items, maps, sheets, monsters, events, farming: monsterTable(G, items), ...spriteIndex(G), version: finite(G.version) };
  }
  // Refreshes at most every 6 hours; a failed refresh keeps serving the previous copy.
  async load() {
    if (this.data && Date.now() - this.loadedAt < REFRESH) return this.data;
    this.loading ||= this.fetchData().then(data => { this.data = data; this.loadedAt = Date.now(); this.maps.clear(); this.looks.clear(); return data; })
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
  // Icon and character sheets are fetched once per file version and kept in memory; a failed download is retried on the next request.
  async sheet(name, kind = 'items') {
    if (!SHEET.test(name)) throw failure(400, 'Neplatný název obrázků.');
    const data = await this.load(), list = kind === 'sprites' ? data.spriteSheets : data.sheets;
    const set = Object.hasOwn(list, name) ? list[name] : null;
    if (!set) throw failure(404, kind === 'sprites' ? 'Obrázky postav neexistují.' : 'Obrázky předmětů neexistují.');
    const key = `${kind}:${name}`, cached = this.sheets.get(key);
    if (cached?.file === set.file) return cached.body;
    const body = this.fetchSheet(set.file).catch(error => { if (this.sheets.get(key)?.body === body) this.sheets.delete(key); throw error; });
    this.sheets.set(key, { file: set.file, body });
    return body;
  }
  spriteSheet(name) { return this.sheet(name, 'sprites'); }
  // Layers drawing a character the way the game's character windows do; without a known look the class's default one.
  async characterSprite({ skin, cx, ctype } = {}) {
    const data = await this.load();
    let look = typeof skin === 'string' && LOOK_KEY.test(skin) ? { skin, cx: cx && typeof cx === 'object' ? cx : {} } : null;
    if (!look) {
      const preset = typeof ctype === 'string' && Object.hasOwn(data.G.classes || {}, ctype) ? data.G.classes[ctype]?.looks?.[0] : null;
      if (!Array.isArray(preset) || typeof preset[0] !== 'string') throw failure(404, 'Vzhled postavy není známý.');
      look = { skin: preset[0], cx: preset[1] && typeof preset[1] === 'object' ? preset[1] : {} };
    }
    const key = JSON.stringify([look.skin, Object.entries(look.cx).filter(([place, id]) => typeof id === 'string').sort()]);
    if (!this.looks.has(key)) {
      if (this.looks.size >= 200) this.looks.clear();
      this.looks.set(key, characterLayers(data.G, data.sprites, look, { width: 40, height: 50, scale: 1.5 }));
    }
    const sprite = this.looks.get(key);
    if (!sprite) throw failure(404, 'Vzhled postavy není známý.');
    return sprite;
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
  async targets() {
    const data = await this.load();
    return { items: Object.entries(data.items).map(([key, item]) => ({ key, name: item.name })), monsters: data.monsters };
  }
  async eventCatalog() { return (await this.load()).events; }
  async monsters() { const data = await this.load(); return { version: data.version, monsters: data.farming }; }
  // Display names are optional: an unreachable data.js must not hide an inventory.
  async itemNames() {
    try { return (await this.load()).items; } catch { return {}; }
  }
}
