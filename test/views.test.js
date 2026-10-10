import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { GameApi } from '../src/game-api.js';
import { GameData } from '../src/game-data.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';
import { equipmentView, itemView, packsView } from '../src/inventory.js';

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
  items: { hpot0: { name: 'Health Potion', type: 'pot' }, ringsj: { name: 'Ring of Strength', type: 'ring', skin: 'ring' }, lost: { name: 'Lost' }, outside: { name: 'Outside' } },
  imagesets: { pack_20: { size: 20, rows: 4, columns: 8, file: '/images/tiles/items/pack_20vt8.png' }, pack_1a: { size: 16, rows: 2, columns: 2, file: '/images/tiles/items/pack_1a.png?v=11' }, evil: { size: 20, rows: 1, columns: 1, file: 'https://example.com/x.png' }, sneaky: { size: 20, rows: 1, columns: 1, file: '/images/../secret.png' } },
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
  return { request, image, runtime, gameApi };
}
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
  assert.deepEqual(inventory.data.items, [{ name: 'hpot0', title: 'Health Potion', icon: { sheet: 'pack_20', x: 80, y: 40, size: 20, width: 160, height: 80 }, level: null, quantity: 3, locked: false, special: null, stat: null }, null]);
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
