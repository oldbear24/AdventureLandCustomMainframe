import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { GameApi } from '../src/game-api.js';
import { GameData } from '../src/game-data.js';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { Runtime, STORAGE_VALUE_LIMIT, sanitizeState, storageView } from '../src/runtime.js';
import { attachLive } from '../src/live.js';
import { History } from '../src/history.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';
import { aggregateItems, equipmentView, itemView, packsView } from '../src/inventory.js';

const apiToken = `mcp_${'a'.repeat(43)}`;
const G = {
  version: 7,
  maps: {
    main: { key: 'main', name: 'Mainland', npcs: [{ id: 'fancypots', position: [10, 20] }, { id: 'broken' }], doors: [[100, 50, 24, 30, 'bank', 0, 1]], monsters: [{ type: 'goo', boundary: [-50, -50, 50, 50], count: 4 }, { type: 'bee', boundaries: [['main', 0, 0, 10, 10], ['other', 1, 1, 2, 2]] }] },
    bank: { key: 'bank', name: 'The Bank', npcs: [], doors: [], monsters: [] },
    hidden: { key: 'hidden', name: 'Hidden', ignore: true },
  },
  geometry: { main: { min_x: -100, max_x: 200, min_y: -80, max_y: 120, x_lines: [[0, -10, 10], ['bad']], y_lines: [[5, -20, 20]] }, bank: { min_x: 0, max_x: 10, min_y: 0, max_y: 10, x_lines: [], y_lines: [] } },
  npcs: { fancypots: { name: 'Ernis' } }, monsters: { goo: { name: 'Goo' }, bee: { name: 'Bee' } },
  items: { hpot0: { name: 'Health Potion', type: 'pot', gives: [['hp', 200], ['bad', 1]] }, helmet: { name: 'Helmet', type: 'helmet', tier: 1, stat: 1, armor: 5, resistance: 6, upgrade: { stat: 1, resistance: 0.5, armor: 0.5 }, grades: [7, 9, 10, 12], explanation: 'Protects the head.', secret: 'x' }, firebow: { name: 'Fire Bow', type: 'weapon', wtype: 'bow', tier: 2, damage_type: 'physical', attack: 30, range: 50, attr0: 2, ability: 'burn', upgrade: { attack: 4, range: 5, attr0: 0.25 }, grades: [6, 9, 10, 12] }, ringsj: { name: 'Ring of Strength', type: 'ring', skin: 'ring' }, lost: { name: 'Lost' }, outside: { name: 'Outside' } },
  imagesets: { pack_20: { size: 20, rows: 4, columns: 8, file: '/images/tiles/items/pack_20vt8.png' }, pack_1a: { size: 16, rows: 2, columns: 2, file: '/images/tiles/items/pack_1a.png?v=11' }, evil: { size: 20, rows: 1, columns: 1, file: 'https://example.com/x.png' }, sneaky: { size: 20, rows: 1, columns: 1, file: '/images/../secret.png' } },
  titles: { lucky: { type: 'all_items', luck: 2, title: 'Lucky' } }, sets: {}, skills: {},
  positions: { hpot0: ['', 4, 2], ring: ['pack_1a', 1, 1], outside: ['', 8, 0] },
};
const dataJs = `var G=${JSON.stringify(G)};`;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture image')]);
const serve = (sheet = png) => async url => url.endsWith('/data.js') ? new Response(dataJs) : new Response(sheet);

test('game data is reduced to drawable maps and item names', async () => {
  let fetches = 0;
  const data = new GameData(async url => { fetches++; assert.equal(url, 'https://adventure.land/data.js'); return new Response(dataJs); });
  const list = await data.mapList();
  assert.deepEqual(list.maps.map(m => m.name), ['main', 'bank']);
  const main = await data.map('main');
  assert.deepEqual(main.bounds, { minX: -100, maxX: 200, minY: -80, maxY: 120 });
  assert.deepEqual(main.xLines, [[0, -10, 10]]); assert.deepEqual(main.yLines, [[5, -20, 20]]);
  assert.deepEqual(main.npcs, [{ id: 'fancypots', name: 'Ernis', x: 10, y: 20 }]);
  assert.deepEqual(main.doors, [{ x: 100, y: 50, w: 24, h: 30, to: 'bank', title: 'The Bank' }]);
  assert.deepEqual(main.monsters.map(m => [m.name, m.box]), [['Goo', [-50, -50, 50, 50]], ['Bee', [0, 0, 10, 10]]]);
  await assert.rejects(data.map('../etc'), { status: 400 });
  await assert.rejects(data.map('hidden'), { status: 404 });
  const items = await data.itemNames();
  assert.equal(items.hpot0.name, 'Health Potion');
  assert.deepEqual(items.hpot0.icon, { sheet: 'pack_20', x: 80, y: 40, size: 20, width: 160, height: 80 });
  assert.deepEqual(items.ringsj.icon, { sheet: 'pack_1a', x: 16, y: 16, size: 16, width: 32, height: 32 });
  assert.equal(items.lost.icon, null); assert.equal(items.outside.icon, null);
  assert.equal(fetches, 1);
  const broken = new GameData(async () => new Response('not javascript'));
  await assert.rejects(broken.mapList(), { status: 502 });
  assert.deepEqual(await broken.itemNames(), {});
});
test('item icon sheets are fetched once from the game and must be PNG', async () => {
  const urls = [];
  const data = new GameData(async url => { urls.push(url); return serve()(url); });
  assert.deepEqual(await data.sheet('pack_1a'), png);
  assert.deepEqual(await data.sheet('pack_1a'), png);
  assert.deepEqual(urls, ['https://adventure.land/data.js', 'https://adventure.land/images/tiles/items/pack_1a.png?v=11']);
  await assert.rejects(data.sheet('evil'), { status: 404 });
  await assert.rejects(data.sheet('sneaky'), { status: 404 });
  await assert.rejects(data.sheet('../x'), { status: 400 });
  const html = new GameData(serve(Buffer.from('<html>')));
  await assert.rejects(html.sheet('pack_20'), { status: 502 });
});
test('item details and stats are computed like the game', async () => {
  const names = await new GameData(serve()).itemNames();
  assert.equal(names.helmet.secret, undefined);
  const helmet = itemView({ name: 'helmet', level: 7, p: 'lucky', stat_type: 'str' }, names);
  assert.equal(helmet.description, 'Protects the head.'); assert.equal(helmet.specialTitle, 'Lucky'); assert.equal(helmet.grade, 1);
  // Base 1 stat + 6 upgrades of 1 + the +7 step (round(1.25) + 1) = 9 str; armor 5 + 0.5·(6 + 1.25) rounds to 9.
  assert.deepEqual(helmet.stats, [['luck', 2], ['str', 9], ['armor', 9], ['resistance', 10]]);
  assert.deepEqual(itemView({ name: 'helmet', level: 0 }, names).stats, [['stat', 1], ['armor', 5], ['resistance', 6]]);
  const bow = itemView({ name: 'firebow', level: 2, p: 'shiny' }, names);
  assert.deepEqual(bow.stats, [['attack', 42], ['range', 60]]);
  assert.deepEqual(bow.ability, { name: 'Burn', chance: 2.5 }); assert.equal(bow.damageType, 'physical');
  assert.deepEqual(itemView({ name: 'hpot0', q: 3 }, names).gives, [['hp', 200]]);
});
test('items are whitelisted and named', () => {
  const icon = { sheet: 'pack_20', x: 0, y: 0, size: 20, width: 20, height: 20 };
  const names = { hpot0: { name: 'Health Potion', icon } };
  assert.deepEqual(itemView({ name: 'hpot0', q: 20, secret: 'x', l: 'l' }, names), { name: 'hpot0', title: 'Health Potion', icon, level: null, quantity: 20, locked: true, special: null, stat: null });
  assert.equal(itemView({ name: '<img onerror=x>' }), null);
  assert.equal(itemView({ name: 'placeholder' }), null);
  assert.equal(itemView({ name: 'ringsj', level: 2, p: 'shiny' }).special, 'shiny');
  assert.deepEqual(equipmentView({ ring1: null, helmet: { name: 'helmet', level: 1 }, trade1: { name: 'x' }, 'bad slot': {} }).map(e => e.slot), ['helmet', 'ring1']);
  assert.deepEqual(packsView({ gold: 5, items10: [], items2: [null], owner: 'x' }).map(p => p.name), ['items2', 'items10']);
});

async function fixture(t, upstream) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-views-'));
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory });
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config, store);
  const gameApi = new GameApi(config, upstream); await gameApi.init();
  const app = createApp(config, store, runtime, null, gameApi, new GameData(serve()));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(origin + endpoint, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const result = await fetch(origin + '/api/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.password }) });
  cookie = result.headers.get('set-cookie').split(';')[0];
  t.after(async () => { app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const image = async endpoint => fetch(origin + endpoint, { headers: { Cookie: cookie } });
  return { request, image, runtime, gameApi, origin };
}
test('each panel page is the shared shell around its own fragment and script', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  for (const [route, page, heading] of [['/', 'overview', 'Tvoje postavy'], ['/map', 'map', 'Živá mapa'], ['/inventory', 'inventory', 'Inventáře a banka'], ['/editor', 'editor', 'CODE editor'], ['/logs', 'logs', 'Živé logy'], ['/events', 'events', 'Bossové a události'], ['/items', 'items', 'Předměty napříč účtem'], ['/stats', 'stats', 'Dlouhodobé statistiky']]) {
    const response = await fetch(f.origin + route);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /Vlastní mainframe/); assert.match(html, new RegExp(heading));
    assert.match(html, new RegExp(`<script type="module" src="/js/${page}.js">`));
    assert.match(html, new RegExp(`data-nav="${page}" aria-current="page"`));
    assert.equal(html.match(/aria-current="page"/g).length, 1);
    assert.doesNotMatch(html, /\{\{|<!-- dialogs -->/);
  }
  assert.match(await (await fetch(`${f.origin}/`)).text(), /id="transfer-dialog"/);
  assert.doesNotMatch(await (await fetch(`${f.origin}/map`)).text(), /id="transfer-dialog"/);
  assert.equal((await fetch(`${f.origin}/js/map.js`)).status, 200);
  assert.equal((await fetch(`${f.origin}/index.html`)).status, 404);
});
test('saved inventories and bank come from the API token without leaking extra fields', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    const method = url.slice(url.lastIndexOf('/') + 1), input = JSON.parse(options.body);
    calls.push(method);
    if (method === 'mainframe_list_characters') return Response.json({ success: true, characters: [] });
    if (method === 'mainframe_get_character') {
      if (input.character !== 'Goldette') return Response.json({ success: false, reason: 'not_found' }, { status: 404 });
      return Response.json({ success: true, profile: { name: 'Goldette', class: 'merchant', level: 33, gold: 55800, synchronized_at: '2026-10-10T01:22:07.157Z', inventory_slots: 42, inventory: [{ name: 'hpot0', q: 3, secret: 'hidden-field' }, null], equipment: { ring1: { name: 'ringsj', level: 1 } }, auth: 'private-auth' } });
    }
    if (method === 'get_bank') return Response.json({ success: true, gold: 465870, retrieved_at: '2026-10-10T01:28:56.665Z', observed_at: null, packs: { items1: [{ name: 'ringsj', level: 0 }], items0: [{ name: 'hpot0', q: 131 }, null] } });
    throw new Error(`Unexpected ${method}`);
  });
  assert.equal((await f.request('/api/inventories/Goldette')).status, 409);
  assert.equal((await f.request('/api/bank')).status, 409);
  await f.gameApi.connect(apiToken);
  const inventory = await f.request('/api/inventories/Goldette');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.data.source, 'saved'); assert.equal(inventory.data.size, 42); assert.equal(inventory.data.gold, 55800);
  assert.deepEqual(inventory.data.items, [{ name: 'hpot0', title: 'Health Potion', icon: { sheet: 'pack_20', x: 80, y: 40, size: 20, width: 160, height: 80 }, level: null, quantity: 3, locked: false, special: null, stat: null, type: 'pot', description: null, specialTitle: null, tier: null, damageType: null, stats: [], grade: 0, gives: [['hp', 200]], duration: null, classes: [], set: null, ability: null }, null]);
  assert.deepEqual(inventory.data.equipment.map(e => [e.slot, e.item.title, e.item.level]), [['ring1', 'Ring of Strength', 1]]);
  assert.equal(JSON.stringify(inventory.data).includes('hidden-field') || JSON.stringify(inventory.data).includes('private-auth'), false);
  assert.equal((await f.request('/api/inventories/Nobody')).status, 404);
  assert.equal((await f.request('/api/inventories/bad%20name')).status, 400);
  const bank = await f.request('/api/bank');
  assert.equal(bank.status, 200); assert.equal(bank.data.source, 'saved'); assert.equal(bank.data.gold, 465870);
  assert.deepEqual(bank.data.packs.map(p => [p.name, p.items.length]), [['items0', 2], ['items1', 1]]);
  const maps = await f.request('/api/maps');
  assert.deepEqual(maps.data.maps.map(m => m.title), ['Mainland', 'The Bank']);
  assert.equal((await f.request('/api/maps/main')).data.title, 'Mainland');
  assert.equal((await f.request('/api/maps/nope')).status, 404);
  const sheet = await f.image('/api/item-sheets/pack_20');
  assert.equal(sheet.status, 200); assert.equal(sheet.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await sheet.arrayBuffer()), png);
  assert.equal((await f.image('/api/item-sheets/evil')).status, 404);
  assert.equal((await fetch(sheet.url)).status, 401);
});
test('a running character is read live, including the bank while inside it', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  const page = { evaluate: async () => ({ name: 'Runner', ctype: 'mage', level: 50, gold: 9, isize: 42, map: 'bank', items: [{ name: 'hpot0', q: 2 }], slots: { mainhand: { name: 'staff', level: 7 } }, bank: { gold: 1000, items0: [{ name: 'ringsj', level: 3 }] } }) };
  f.runtime.sessions.set('id-1', { id: 'id-1', status: 'running', page, character: { name: 'Runner' }, state: { map: 'bank' } });
  const inventory = await f.request('/api/inventories/runner');
  assert.equal(inventory.data.source, 'live'); assert.equal(inventory.data.equipment[0].item.level, 7);
  const bank = await f.request('/api/bank');
  assert.equal(bank.data.source, 'live'); assert.equal(bank.data.via, 'Runner'); assert.equal(bank.data.gold, 1000);
  assert.equal(bank.data.packs[0].items[0].title, 'Ring of Strength');
  f.runtime.sessions.clear();
});

test('items of all characters and the bank are grouped with their locations', async t => {
  const names = { ringsj: { name: 'Ring of Strength', compound: { str: 1 } }, helmet: { name: 'Helmet', upgrade: { armor: 1 } } };
  const view = (name, extra = {}) => ({ ...itemView({ name, ...extra }, names) });
  const result = aggregateItems([
    { kind: 'character', name: 'A', source: 'live', gold: 10, items: [view('ringsj', { level: 1 }), null, view('ringsj', { level: 1, l: 'l' }), view('hpot0', { q: 5 })], equipment: [{ slot: 'ring1', item: view('ringsj', { level: 1 }) }, { slot: 'helmet', item: null }] },
    { kind: 'character', name: 'B', error: 'Postava nepatří účtu.' },
    { kind: 'bank', name: null, source: 'saved', gold: 100, observedAt: null, retrievedAt: '2026-10-10T00:00:00.000Z', packs: [{ name: 'items0', items: [view('ringsj', { level: 1 }), view('hpot0', { q: 7 }), view('helmet', { level: 7, p: 'shiny' })] }] },
  ], names);
  assert.equal(result.gold, 110);
  assert.deepEqual(result.sources.map(s => [s.name, s.error ?? s.source]), [['A', 'live'], ['B', 'Postava nepatří účtu.'], [null, 'saved']]);
  const ring = result.items.find(i => i.name === 'ringsj');
  assert.equal(ring.total, 4); assert.equal(ring.upgrade, 'compound');
  assert.deepEqual(ring.locations, [{ owner: 'A', place: 'equipment', locked: false, count: 1 }, { owner: 'A', place: 'inventory', locked: false, count: 1 }, { owner: 'A', place: 'inventory', locked: true, count: 1 }, { owner: null, place: 'bank', locked: false, count: 1 }]);
  assert.equal(result.items.find(i => i.name === 'hpot0').total, 12);
  const helmet = result.items.find(i => i.name === 'helmet');
  assert.equal(helmet.upgrade, 'upgrade'); assert.equal(helmet.special, 'shiny'); assert.equal(helmet.level, 7);
});
test('the items endpoint reads every account character and the bank once a minute', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    const method = url.slice(url.lastIndexOf('/') + 1), input = JSON.parse(options.body);
    calls.push(method);
    if (method === 'mainframe_list_characters') return Response.json({ success: true, characters: [{ character: 'Goldette', level: 33, class: 'merchant' }, { character: 'Gone', level: 1, class: 'mage' }] });
    if (method === 'mainframe_get_character') {
      if (input.character !== 'Goldette') return Response.json({ success: false, reason: 'not_found' }, { status: 404 });
      return Response.json({ success: true, profile: { name: 'Goldette', class: 'merchant', level: 33, gold: 50, inventory: [{ name: 'hpot0', q: 3 }], equipment: { helmet: { name: 'helmet', level: 2 } } } });
    }
    if (method === 'get_bank') return Response.json({ success: true, gold: 1000, packs: { items0: [{ name: 'hpot0', q: 10 }] } });
    throw new Error(`Unexpected ${method}`);
  });
  await f.gameApi.connect(apiToken); calls.length = 0;
  const result = await f.request('/api/items');
  assert.equal(result.status, 200);
  assert.equal(result.data.gold, 1050);
  assert.deepEqual(result.data.sources.map(s => [s.name, s.error ? 'error' : s.source]), [['Goldette', 'saved'], ['Gone', 'error'], [null, 'saved']]);
  const potion = result.data.items.find(i => i.name === 'hpot0');
  assert.equal(potion.title, 'Health Potion'); assert.equal(potion.total, 13);
  assert.deepEqual(potion.locations.map(l => [l.owner, l.place, l.count]), [['Goldette', 'inventory', 3], [null, 'bank', 10]]);
  const before = calls.length;
  await f.request('/api/items'); await f.request('/api/items?refresh=1');
  assert.equal(calls.length, before, 'cached for a minute and a refresh at most every 10 seconds');
});

test('long-term stats are bucketed by the viewer\'s hours and days', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  assert.deepEqual((await f.request('/api/history/stats')).data.characters, []);
  assert.equal((await f.request('/api/history/stats')).data.available, false);
  const now = Date.now();
  f.runtime.history = new History(null, () => {}, () => now);
  f.runtime.history.samples.set('id-1', { name: 'Runner', points: [[now - 2 * 3_600_000, 5, 0, 100, 10], [now - 2 * 3_600_000 + 300_000, 5, 50, 100, 30], [now - 3_600_000, 6, 10, 200, 40]] });
  const day = await f.request('/api/history/stats?range=24h&offset=120');
  assert.equal(day.status, 200); assert.equal(day.data.available, true);
  assert.equal(day.data.bucketMs, 3_600_000); assert.equal(day.data.to - day.data.from, 86_400_000);
  assert.equal((day.data.to + 120 * 60_000) % 3_600_000, 0, 'buckets end on a whole hour of the viewer');
  const [runner] = day.data.characters;
  assert.equal(runner.xpGained, 50); assert.equal(runner.buckets.length, 24); assert.equal(runner.series.length, 3);
  const week = await f.request('/api/history/stats?range=7d&offset=-300');
  assert.equal(week.data.bucketMs, 86_400_000); assert.equal((week.data.to - 300 * 60_000) % 86_400_000, 0);
  assert.equal((await f.request('/api/history/stats?range=1y')).status, 400);
  assert.equal((await f.request('/api/history/stats?offset=9999')).status, 400);
  f.runtime.history = null;
});

test('server events list realms and save which events notify', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  f.runtime.servers.set('EU I', { realm: 'EU I', via: 'Runner', observedAt: 1, events: [{ key: 'franky', live: true }], schedule: null });
  const result = await f.request('/api/server-events');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.realms.map(r => r.realm), ['EU I']);
  assert.ok(result.data.catalog.some(e => e.key === 'franky' && e.kind === 'boss'));
  assert.deepEqual(result.data.notifyEvents, []);
  assert.deepEqual((await f.request('/api/settings/notify-events', 'PUT', { keys: ['icegolem', 'franky', 'franky'] })).data, { notifyEvents: ['franky', 'icegolem'] });
  assert.deepEqual((await f.request('/api/server-events')).data.notifyEvents, ['franky', 'icegolem']);
  assert.equal((await f.request('/api/settings/notify-events', 'PUT', { keys: ['<b>'] })).status, 400);
  f.runtime.servers.clear();
});

test('values stored by CODE set() are listed live, pretty-printed and bounded', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  assert.equal((await f.request('/api/characters/id-1/storage')).status, 409);
  const storage = { cstore_farm: JSON.stringify({ map: 'main', kills: 12 }), cstore_broken: '{bad', cstore_big: JSON.stringify('x'.repeat(STORAGE_VALUE_LIMIT + 10)), activity: 'game setting' };
  const page = { evaluate: async (fn, prefix) => {
    const previous = globalThis.window; globalThis.window = { localStorage: { ...storage, getItem: key => storage[key] ?? null } };
    try { return fn(prefix); } finally { globalThis.window = previous; }
  } };
  // Object.keys on the fake localStorage also sees getItem; it is filtered out by the prefix like any game key.
  f.runtime.sessions.set('id-1', { id: 'id-1', status: 'running', page, character: { name: 'Runner' } });
  const result = await f.request('/api/characters/id-1/storage');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.entries.map(e => e.key), ['big', 'broken', 'farm']);
  const [big, broken, farm] = result.data.entries;
  assert.equal(farm.value, '{\n  "map": "main",\n  "kills": 12\n}'); assert.equal(farm.valid, true);
  assert.equal(broken.value, '{bad'); assert.equal(broken.valid, false);
  assert.equal(big.truncated, true); assert.equal(big.value.length, STORAGE_VALUE_LIMIT);
  assert.equal(result.data.total, 3);
  assert.equal(JSON.stringify(result.data).includes('game setting'), false);
  f.runtime.sessions.clear();
  const many = storageView(Array.from({ length: 600 }, (_, i) => ({ key: `k${i}`, value: String(i) })).concat([null, { key: 1, value: 'x' }]));
  assert.equal(many.entries.length, 500); assert.equal(many.total, 600);
  const flags = storageView([{ key: 'k'.repeat(201), value: '1' }, { key: 'hidden', value: '"[REDACTED]"' }, { key: 'ok', value: '1' }]).entries;
  assert.deepEqual(flags.map(e => [e.key.slice(0, 6), e.deletable, e.editable]), [['hidden', true, false], ['kkkkkk', false, false], ['ok', true, true]]);
  assert.equal(big.editable, false); assert.equal(big.deletable, true); assert.equal(farm.editable, true);
});

test('values stored by CODE set() can be edited, deleted and cleared', async t => {
  const f = await fixture(t, async () => { throw new Error('No API requests expected'); });
  assert.equal((await f.request('/api/characters/id-1/storage/farm', 'PUT', { value: '1' })).status, 409);
  const storage = new Map([['cstore_farm', '{"kills":1}'], ['cstore_a/b c', '"x"'], ['cstore_old', '2'], ['activity', 'game setting']]);
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const page = { evaluate: async (fn, arg) => {
    const previous = globalThis.window; globalThis.window = { localStorage: new Proxy(localStorage, { ownKeys: () => [...storage.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }) };
    try { return fn(arg); } finally { globalThis.window = previous; }
  } };
  f.runtime.sessions.set('id-1', { id: 'id-1', status: 'running', page, character: { name: 'Runner' } });
  assert.equal((await f.request('/api/characters/id-1/storage/farm', 'PUT', { value: '{\n  "kills": 5,\n  "map": "main"\n}' })).status, 200);
  assert.equal(storage.get('cstore_farm'), '{"kills":5,"map":"main"}');
  assert.equal((await f.request('/api/characters/id-1/storage/new', 'PUT', { value: '"leader"' })).status, 200);
  assert.equal(storage.get('cstore_new'), '"leader"');
  const invalid = await f.request('/api/characters/id-1/storage/farm', 'PUT', { value: '{kills: 5}' });
  assert.equal(invalid.status, 400); assert.match(invalid.data.error, /JSON/);
  assert.equal((await f.request('/api/characters/id-1/storage/farm', 'PUT', { value: '1', extra: true })).status, 400);
  assert.equal((await f.request(`/api/characters/id-1/storage/${'k'.repeat(201)}`, 'PUT', { value: '1' })).status, 400);
  assert.deepEqual((await f.request(`/api/characters/id-1/storage/${encodeURIComponent('a/b c')}`, 'DELETE', {})).data, { removed: true });
  assert.equal(storage.has('cstore_a/b c'), false);
  assert.deepEqual((await f.request('/api/characters/id-1/storage/missing', 'DELETE', {})).data, { removed: false });
  assert.deepEqual((await f.request('/api/characters/id-1/storage', 'DELETE', {})).data, { removed: 3 });
  assert.deepEqual([...storage.keys()], ['activity']);
  f.runtime.sessions.clear();
});
test('game state is sanitized before it reaches the panel', () => {
  const state = sanitizeState(JSON.stringify({ name: 'A'.repeat(100), level: 5, x: 1.5, y: 'bad', nearby: [{ kind: 'boss', name: 'goo', x: 1.4, y: 2, target: 1, extra: 'x' }, { x: 'nope' }], secret: 'x' }));
  assert.equal(state.name.length, 32); assert.equal(state.x, 1.5); assert.equal(state.y, 0);
  assert.deepEqual(state.nearby, [{ id: '', kind: 'character', name: 'goo', x: 1, y: 2, target: true }]);
  assert.ok(Math.abs(state.at - Date.now()) < 1000, 'a missing sampling time falls back to now');
  const sampled = Date.now() - 500, withTime = sanitizeState({ at: sampled, nearby: [{ id: 'm42', x: 0, y: 0 }] });
  assert.equal(withTime.at, sampled); assert.equal(withTime.nearby[0].id, 'm42');
  assert.ok(sanitizeState({ at: 5 }).at > 5, 'an implausible sampling time is replaced');
  assert.equal('secret' in state, false);
  assert.equal(sanitizeState('{broken'), null); assert.equal(sanitizeState('x'.repeat(70_000)), null);
});
test('live WebSocket requires panel session and Origin, pushes state and logs and closes on logout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-live-'));
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory });
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config, store);
  const app = createApp(config, store, runtime);
  const server = createServer(app); const live = attachLive(server, app, runtime);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
  app.locals.publicOrigin = origin;
  t.after(async () => { live.close(); app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const status = headers => new Promise(resolve => {
    const ws = new WebSocket(`ws://${host}/api/live`, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)); ws.on('open', () => { ws.close(); resolve(101); }); ws.on('error', () => {});
  });
  assert.equal(await status({ Origin: origin }), 401);
  assert.equal(await status({ Origin: 'https://evil.example', Cookie: cookie }), 403);
  const ws = new WebSocket(`ws://${host}/api/live`, { headers: { Origin: origin, Cookie: cookie } });
  const messages = [];
  ws.on('message', data => messages.push(JSON.parse(data)));
  await once(ws, 'open');
  const waitFor = async predicate => { for (let i = 0; i < 50 && !messages.some(predicate); i++) await new Promise(resolve => setTimeout(resolve, 20)); return messages.find(predicate); };
  const snapshot = await waitFor(m => m.type === 'snapshot');
  assert.deepEqual(snapshot.sessions, []); assert.deepEqual(snapshot.logs, runtime.logs);
  runtime.emit('state', 'id-1', { x: 1 }); runtime.emit('state', 'id-1', { x: 2 }); runtime.emit('state', 'id-2', null);
  assert.deepEqual((await waitFor(m => m.type === 'states')).states, [{ id: 'id-1', state: { x: 2 } }, { id: 'id-2', state: null }]);
  // Every log entry is pushed, batched and in order.
  runtime.log('id-1', 'info', 'first'); runtime.log(null, 'error', 'second');
  const logs = (await waitFor(m => m.type === 'logs')).logs;
  assert.deepEqual(logs.map(l => [l.characterId, l.level, l.message]), [['id-1', 'info', 'first'], [null, 'error', 'second']]);
  assert.ok(logs[1].id > logs[0].id);
  // The dashboard leaves logs out on request, for a panel that receives them over the WebSocket.
  const dashboard = async query => (await fetch(`${origin}/api/dashboard${query}`, { headers: { Cookie: cookie } })).json();
  assert.equal((await dashboard('?logs=0')).logs, undefined);
  assert.equal((await dashboard('')).logs.at(-1).message, 'second');
  const closed = once(ws, 'close');
  await fetch(`${origin}/api/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await closed)[0], 4401);
});
