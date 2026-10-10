import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { GameApi } from '../src/game-api.js';
import { GameAccount } from '../src/game-account.js';
import { Transfers, inventoryView } from '../src/transfers.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';

const apiToken = `mcp_${'a'.repeat(43)}`;
async function fixture(t, upstream) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-transfer-'));
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory });
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config, store);
  const account = new GameAccount(config, runtime, async () => { throw new Error('No live game requests'); }); await account.init();
  const gameApi = new GameApi(config, upstream || (async () => { throw new Error('No live API requests'); })); await gameApi.init();
  const app = createApp(config, store, runtime, account, gameApi);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (endpoint, method = 'GET', body, headers = {}) => {
    const response = await fetch(origin + endpoint, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), response };
  };
  const login = async () => { const result = await request('/api/login', 'POST', { password: config.password }); cookie = result.response.headers.get('set-cookie').split(';')[0]; };
  t.after(async () => { app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { config, directory, runtime, gameApi, request, login };
}

test('API token uses official read-only endpoint, remains encrypted and survives restart', async t => {
  const f = await fixture(t, async (url, options) => {
    assert.equal(url, 'https://adventure.land/mcp_api/mainframe_list_characters');
    assert.equal(options.redirect, 'error'); assert.deepEqual(JSON.parse(options.body), { token: apiToken });
    return Response.json({ success: true, characters: [{ character: 'OwnedWarrior', level: 42, class: 'warrior', profile: { online: true, secret: 'private-character-secret' } }] });
  });
  assert.equal((await f.request('/api/owned-characters')).status, 401);
  await f.login(); assert.equal((await f.request('/api/owned-characters')).status, 409);
  assert.equal((await f.request('/api/account/token', 'POST', { token: 'bad' })).status, 400);
  const connected = await f.request('/api/account/token', 'POST', { token: apiToken });
  assert.equal(connected.status, 200); assert.deepEqual(connected.data.characters, [{ name: 'OwnedWarrior', level: 42, class: 'warrior', online: true }]);
  assert.equal(JSON.stringify(connected.data).includes('private-character-secret'), false);
  assert.equal((await readFile(path.join(f.directory, 'api-token.enc.json'), 'utf8')).includes(apiToken), false);
  assert.equal(JSON.stringify((await f.request('/api/dashboard')).data).includes(apiToken), false);
  const restored = new GameApi(f.config, f.gameApi.request); await restored.init(); assert.equal(restored.status().configured, true);
  assert.equal((await restored.characters()).characters[0].name, 'OwnedWarrior');
  await f.request('/api/account/token/disconnect', 'POST', {});
  const disconnected = new GameApi(f.config); await disconnected.init(); assert.equal(disconnected.status().configured, false);
});

test('invalid upstream token preserves saved token without exposing upstream details', async t => {
  let valid = true;
  const f = await fixture(t, async () => Response.json(valid ? { success: true, characters: [] } : { failed: true, reason: 'invalid_token', debug: apiToken }));
  await f.login(); assert.equal((await f.request('/api/account/token', 'POST', { token: apiToken })).status, 200);
  valid = false;
  const result = await f.request('/api/account/token', 'POST', { token: `mcp_${'b'.repeat(43)}` });
  assert.equal(result.status, 401); assert.equal(JSON.stringify(result.data).includes(apiToken), false); assert.equal(f.gameApi.vault.config.authCookie, apiToken);
});

function transferFixture() {
  const id = randomUUID(), page = {}, item = { name: 'hpot0', q: 5 };
  let snapshot = { name: 'Sender', gold: 1000, items: [{ index: 0, name: item.name, level: 0, quantity: 5, locked: false, serialized: JSON.stringify(item) }] };
  let calls = 0;
  const runtime = { sessions: new Map([[id, { page, status: 'running' }]]), queue: Promise.resolve(),
    exclusive(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; },
    inventory: async () => structuredClone(snapshot), sendTransfer: async () => { calls++; return { status: 'confirmed', message: 'Fixture sent' }; }, log() {},
  };
  return { id, page, runtime, transfers: new Transfers(runtime), snapshot, setSnapshot(value) { snapshot = value; }, calls: () => calls };
}
test('preview has no side effect and concurrent confirmation executes once', async () => {
  const f = transferFixture();
  const quote = await f.transfers.prepare({ characterId: f.id, type: 'gold', to: 'Receiver', amount: 200 }, 'session1');
  assert.equal(f.calls(), 0); assert.equal(quote.from, 'Sender');
  assert.throws(() => f.transfers.confirm(quote.id, 'session2'), /neexistuje/);
  const results = await Promise.all([f.transfers.confirm(quote.id, 'session1'), f.transfers.confirm(quote.id, 'session1')]);
  assert.equal(f.calls(), 1); assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await f.transfers.confirm(quote.id, 'session1'), results[0]); assert.equal(f.calls(), 1);
});
test('preview rejects invalid amounts, changed inventory, locked items and self transfer', async () => {
  const f = transferFixture();
  assert.throws(() => f.transfers.prepare({ characterId: f.id, type: 'gold', to: 'Receiver', amount: -1 }, 'owner'));
  await assert.rejects(f.transfers.prepare({ characterId: f.id, type: 'gold', to: 'Receiver', amount: 1001 }, 'owner'), /dost zlata/);
  await assert.rejects(f.transfers.prepare({ characterId: f.id, type: 'gold', to: 'sender', amount: 1 }, 'owner'), /jiná postava/);
  const input = { characterId: f.id, type: 'item', to: 'Receiver', index: 0, quantity: 1, fingerprint: inventoryView(f.snapshot).items[0].fingerprint };
  await assert.rejects(f.transfers.prepare({ ...input, fingerprint: 'a'.repeat(64) }, 'owner'), /Inventář se změnil/);
  await assert.rejects(f.transfers.prepare({ ...input, quantity: 6 }, 'owner'), /počet/);
  f.setSnapshot({ ...f.snapshot, items: [{ ...f.snapshot.items[0], locked: true }] });
  await assert.rejects(f.transfers.prepare(input, 'owner'), /Zamčený/);
});
test('expired previews and replaced browser sessions never execute a transfer', async () => {
  const f = transferFixture(), input = { characterId: f.id, type: 'gold', to: 'Receiver', amount: 1 };
  const expired = await f.transfers.prepare(input, 'owner'); f.transfers.tickets.get(expired.id).expires = 0;
  await assert.rejects(f.transfers.confirm(expired.id, 'owner'), /vypršelo/);
  const changed = await f.transfers.prepare(input, 'owner'); f.runtime.sessions.get(f.id).page = {};
  await assert.rejects(f.transfers.confirm(changed.id, 'owner'), /spojení se změnilo/); assert.equal(f.calls(), 0);
});

function runtimeBridgeFixture() {
  const runtime = new Runtime({ authCookie: '' }, { snapshot: () => ({}) });
  const id = randomUUID(), sent = [], item = { name: 'hpot0', q: 5 };
  const character = { name: 'Sender', gold: 1000, items: [item] };
  const runner = {
    send_gold: async (name, gold) => { sent.push({ name, gold }); return { response: 'gold_sent', name, gold }; },
    send_item: async (name, num, q) => { sent.push({ name, num, q }); return { response: 'item_sent', name, num, q, item: 'hpot0' }; },
  };
  const sandbox = { window: { character, socket: { connected: true }, code_active: true }, document: { getElementById: () => ({ contentWindow: runner }) } };
  const page = { evaluate: (fn, input) => runInNewContext(`(${fn.toString()})(input)`, { ...sandbox, input }) };
  runtime.sessions.set(id, { status: 'running', page });
  return { runtime, id, character, runner, sandbox, sent, item };
}
test('game bridge verifies exact item immediately before sending and validates game confirmation', async () => {
  const f = runtimeBridgeFixture();
  const command = { characterId: f.id, to: 'Receiver', type: 'item', index: 0, quantity: 2, expectedItem: JSON.stringify(f.item), itemName: 'hpot0' };
  assert.equal((await f.runtime.sendTransfer(command)).status, 'confirmed'); assert.equal(f.sent.length, 1);
  f.item.q = 3; assert.equal((await f.runtime.sendTransfer(command)).status, 'failed'); assert.equal(f.sent.length, 1);
  f.runner.send_gold = async () => ({ response: 'gold_sent', name: 'DifferentRecipient', gold: 10 });
  assert.equal((await f.runtime.sendTransfer({ characterId: f.id, to: 'Receiver', type: 'gold', amount: 10 })).status, 'unknown');
});
test('game bridge blocks missing CODE and insufficient funds; rejection is not success', async () => {
  const f = runtimeBridgeFixture(), command = { characterId: f.id, to: 'Receiver', type: 'gold', amount: 10 };
  f.sandbox.window.code_active = false; assert.equal((await f.runtime.sendTransfer(command)).status, 'failed'); assert.equal(f.sent.length, 0);
  f.sandbox.window.code_active = true; f.character.gold = 0; assert.equal((await f.runtime.sendTransfer(command)).status, 'failed'); assert.equal(f.sent.length, 0);
  f.character.gold = 1000; f.runner.send_gold = async () => { throw { reason: 'distance' }; };
  const rejected = await f.runtime.sendTransfer(command); assert.equal(rejected.status, 'failed'); assert.match(rejected.message, /stejné mapě/);
  f.runner.send_gold = async () => { throw { reason: 'disconnected' }; };
  assert.equal((await f.runtime.sendTransfer(command)).status, 'unknown');
});

test('transfer HTTP endpoints require auth and valid input; logout invalidates preview owner', async t => {
  const f = await fixture(t), id = randomUUID();
  assert.equal((await f.request('/api/transfers/prepare', 'POST', {})).status, 401);
  await f.login(); assert.equal((await f.request('/api/transfers/prepare', 'POST', {})).status, 400);
  assert.equal((await f.request(`/api/characters/${id}/inventory`)).status, 409);
  const source = transferFixture(); f.runtime.sessions.set(id, { status: 'running', page: source.page });
  f.runtime.inventory = source.runtime.inventory; f.runtime.sendTransfer = source.runtime.sendTransfer;
  const quote = await f.request('/api/transfers/prepare', 'POST', { characterId: id, to: 'Receiver', type: 'gold', amount: 50 });
  assert.equal(quote.status, 200); assert.equal(source.calls(), 0);
  assert.equal((await f.request(`/api/transfers/${quote.data.id}/confirm`, 'POST', {}, { Origin: 'https://evil.example' })).status, 403);
  await f.request('/api/logout', 'POST', {}); await f.login();
  assert.equal((await f.request(`/api/transfers/${quote.data.id}/confirm`, 'POST', {})).status, 404); assert.equal(source.calls(), 0);
});
