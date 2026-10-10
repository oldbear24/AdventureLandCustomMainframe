import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { GameApi } from '../src/game-api.js';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-code-sync-'));
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory, AL_AUTH_COOKIE: 'fixture-cookie' });
  const store = new Store(directory); await store.init();
  const cloud = { code: { slot: '1', name: 'Shared farm', version: 1, code: 'console.log("cloud v1");' }, available: true, writes: 0, modules: [] };
  const api = new GameApi(config, async (url, options) => {
    const input = JSON.parse(options.body); assert.equal(input.token, `mcp_${'a'.repeat(43)}`);
    if (!cloud.available) throw new Error('Fixture offline');
    const method = url.slice(url.lastIndexOf('/') + 1);
    if (method === 'mainframe_list_characters') return Response.json({ success: true, characters: [{ character: 'Warrior', character_id: 'CH_warrior', level: 50, class: 'warrior', assignment: { code_slot: '1', server: 'EU I' } }] });
    if (method === 'list_codes') return Response.json({ success: true, codes: [...(cloud.code ? [{ slot: '1', name: cloud.code.name, version: cloud.code.version }] : []), ...cloud.modules] });
    if (method === 'get_code') return Response.json(cloud.code ? { success: true, code: { ...cloud.code } } : { failed: true, reason: 'not_found' });
    if (method === 'save_code') { cloud.writes++; cloud.code = { ...cloud.code, code: input.code, name: input.name, version: cloud.code.version + 1 }; return Response.json({ success: true, code: { slot: '1', version: cloud.code.version } }); }
    throw new Error('Unexpected live method');
  }); await api.init(); await api.vault.save({ cookie: `mcp_${'a'.repeat(43)}` });
  const runtime = new Runtime(config, store, undefined, api);
  const app = createApp(config, store, runtime, null, api);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`; let cookie = '';
  const request = async (endpoint, method = 'GET', body) => {
    const response = await fetch(origin + endpoint, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), response };
  };
  const login = await request('/api/login', 'POST', { password: config.password }); cookie = login.response.headers.get('set-cookie').split(';')[0];
  t.after(async () => { app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { store, runtime, api, cloud, request, directory };
}
async function sessionFixture(f, scriptId, name = 'Warrior') {
  const id = randomUUID();
  await f.store.update(state => state.characters.push({ id, name, region: 'EU', server: 'I', scriptId, autoStart: false }));
  const window = { code_run: false, code_active: false, starts: 0, code: '', character: { name, gold: 1000, items: [] }, socket: { connected: true } };
  window.start_runner = (_id, source) => { window.code = source; window.starts++; window.code_run = window.code_active = true; window.onStart?.(); };
  window.stop_runner = () => { window.code_run = window.code_active = false; };
  const page = { evaluate: async (fn, input) => runInNewContext(`(${fn.toString()})(input)`, { window, input }), waitForFunction: async () => assert.equal(window.code_active, true) };
  const session = { id, status: 'running', page, context: { close: async () => { window.socket.connected = false; } }, attempts: 0 };
  f.runtime.sessions.set(id, session);
  return { session, window };
}

test('import links a game slot, persists its identity and reads new browser saves in editor', async t => {
  const f = await fixture(t);
  const slots = await f.request('/api/code-slots'); assert.equal(slots.status, 200); assert.equal(slots.data.slots[0].slot, '1');
  const imported = await f.request('/api/code-slots/1/import', 'POST', {}); assert.equal(imported.status, 200);
  assert.equal(imported.data.remoteSlot, '1'); assert.equal(imported.data.source, f.cloud.code.code);
  assert.equal(f.cloud.writes, 0);
  const again = await f.request('/api/code-slots/1/import', 'POST', {}); assert.equal(again.data.id, imported.data.id); assert.equal(f.store.snapshot().scripts.length, 1);
  f.cloud.code = { ...f.cloud.code, version: 2, code: 'console.log("browser saved v2");' };
  const read = await f.request(`/api/scripts/${imported.data.id}`); assert.equal(read.data.source, f.cloud.code.code); assert.equal(read.data.remoteVersion, '2');
  const restored = new Store(f.directory); await restored.init(); assert.equal(restored.snapshot().scripts[0].remoteSlot, '1');
});
test('start always reads cloud source; polling updates all linked runners without restarting unchanged code', async t => {
  const f = await fixture(t), script = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  const first = await sessionFixture(f, script.id), second = await sessionFixture(f, script.id, 'Mage');
  f.cloud.code = { ...f.cloud.code, version: 2, code: 'console.log("fresh at start");' };
  await f.runtime.loadScript(first.session); await f.runtime.loadScript(second.session);
  assert.equal(first.window.code, f.cloud.code.code); assert.equal(first.window.starts, 1);
  await f.runtime.syncSharedScripts(); assert.equal(first.window.starts, 1);
  f.cloud.code = { ...f.cloud.code, version: 3, code: 'console.log("browser edit");' };
  f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts();
  assert.equal(first.window.code, f.cloud.code.code); assert.equal(second.window.code, f.cloud.code.code); assert.equal(first.window.starts, 2);
});
test('saving from panel writes the shared slot and reloads assigned runners; conflicts do not overwrite browser edits', async t => {
  const f = await fixture(t), script = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  const running = await sessionFixture(f, script.id); await f.runtime.loadScript(running.session);
  const input = { name: 'Shared farm', source: 'console.log("panel edit");', expectedVersion: '1' };
  const saved = await f.request(`/api/scripts/${script.id}`, 'PUT', input);
  assert.equal(saved.status, 200); assert.equal(f.cloud.writes, 1); assert.equal(f.cloud.code.code, input.source); assert.equal(running.window.code, input.source);
  f.cloud.code = { ...f.cloud.code, version: 3, code: 'console.log("newer browser edit");' };
  const conflict = await f.request(`/api/scripts/${script.id}`, 'PUT', { ...input, source: 'console.log("stale editor");', expectedVersion: '2' });
  assert.equal(conflict.status, 409); assert.equal(f.cloud.writes, 1); assert.equal(f.cloud.code.code, 'console.log("newer browser edit");');
});
test('a change in a slot loaded by require_code reloads the CODE even when the main slot is unchanged', async t => {
  const f = await fixture(t), script = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  f.cloud.modules = [{ slot: '99', name: 'fighter-shared', version: 11 }];
  const running = await sessionFixture(f, script.id);
  running.window.onStart = () => {
    f.runtime.trackModule(running.session, running.session.page, 'https://adventure.land/code.js?name=99&xrequire=1&timestamp=1');
    f.runtime.trackModule(running.session, running.session.page, 'https://example.com/code.js?name=evil');
    f.runtime.trackModule(running.session, {}, 'https://adventure.land/code.js?name=stale-page');
  };
  await f.runtime.loadScript(running.session);
  assert.deepEqual(f.runtime.snapshot()[0].code.modules, [{ name: '99', version: '11' }]);
  f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts(); assert.equal(running.window.starts, 1);
  f.cloud.modules = [{ slot: '99', name: 'fighter-shared', version: 12 }];
  f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts();
  assert.equal(running.window.starts, 2); assert.deepEqual(f.runtime.snapshot()[0].code.modules, [{ name: '99', version: '12' }]);
  assert.ok(f.runtime.logs.some(l => l.message.includes('Změnil se modul CODE 99 (verze 11 → 12)')));
  f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts(); assert.equal(running.window.starts, 2);
});
test('API failure pauses code and recovery resumes current slot; deleted slot never falls back to cache', async t => {
  const f = await fixture(t), script = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  const running = await sessionFixture(f, script.id); await f.runtime.loadScript(running.session);
  f.cloud.available = false; await f.runtime.syncSharedScripts();
  assert.equal(running.window.code_active, false); assert.match(running.session.code.error, /pozastaven/);
  f.cloud.available = true; f.cloud.code = { ...f.cloud.code, code: 'console.log("recovered newest source");', version: 2 };
  f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts(); assert.equal(running.window.code_active, true); assert.equal(running.window.code, f.cloud.code.code);
  f.cloud.code = null; f.runtime.nextCodeSync = 0; await f.runtime.syncSharedScripts(); assert.equal(running.window.code_active, false);
});
test('local drafts cannot run, active slot identity cannot change, and removing local link does not delete game slot', async t => {
  const f = await fixture(t), draft = (await f.request('/api/scripts', 'POST', { name: 'Local draft', source: 'console.log("draft");' })).data;
  const running = await sessionFixture(f, draft.id); f.runtime.sessions.delete(running.session.id);
  await assert.rejects(f.runtime.start(running.session.id), /Místní návrh nelze spustit/); assert.equal(f.runtime.sessions.size, 0);
  const shared = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  const active = await sessionFixture(f, shared.id); await f.runtime.loadScript(active.session);
  assert.equal((await f.request('/api/code-slots/2/import', 'POST', { scriptId: shared.id })).status, 409);
  assert.equal((await f.request(`/api/scripts/${shared.id}`, 'DELETE', {})).status, 409);
  await f.runtime.stop(active.session.id);
  await f.store.update(state => { state.characters = state.characters.filter(c => c.scriptId !== shared.id); });
  assert.equal((await f.request(`/api/scripts/${shared.id}`, 'DELETE', {})).status, 200); assert.ok(f.cloud.code); assert.equal(f.cloud.writes, 0);
});
test('start downloads the slot before connecting and refuses to connect when the download fails', async t => {
  const f = await fixture(t), script = (await f.request('/api/code-slots/1/import', 'POST', {})).data;
  let launches = 0;
  const runtime = new Runtime(f.runtime.config, f.store, { launch: async () => { launches++; throw new Error('No browser in tests'); } }, f.api);
  t.after(() => runtime.close());
  const id = randomUUID();
  await f.store.update(state => state.characters.push({ id, name: 'Warrior', region: 'EU', server: 'I', scriptId: script.id, autoStart: false }));
  f.cloud.available = false;
  await assert.rejects(runtime.start(id), /Stažení CODE před startem selhalo/);
  assert.equal(runtime.sessions.size, 0); assert.equal(launches, 0);
  f.cloud.available = true; f.cloud.code = { ...f.cloud.code, version: 4, code: 'console.log("downloaded before start");' };
  await runtime.start(id);
  assert.equal(f.store.snapshot().scripts[0].source, f.cloud.code.code); assert.equal(launches, 1);
  assert.ok(runtime.logs.some(l => l.message.includes('CODE stažen ze slotu 1 (verze 4)')));
});
test('start without assigned CODE detects, downloads and assigns the character default slot', async t => {
  const f = await fixture(t);
  const runtime = new Runtime(f.runtime.config, f.store, { launch: async () => { throw new Error('No browser in tests'); } }, f.api);
  t.after(() => runtime.close());
  const id = randomUUID();
  await f.store.update(state => state.characters.push({ id, name: 'warrior', region: 'EU', server: 'I', scriptId: null, autoStart: false }));
  await runtime.start(id);
  const character = f.store.snapshot().characters.find(c => c.id === id), script = f.store.snapshot().scripts.find(s => s.id === character.scriptId);
  assert.equal(script.remoteSlot, '1'); assert.equal(script.source, f.cloud.code.code);
  assert.ok(runtime.logs.some(l => l.message.includes('Detekován výchozí CODE postavy: slot 1')));
  await runtime.stop(id);
  // The slot is reused, not duplicated, and an empty default slot starts without CODE.
  await f.store.update(state => { state.characters.find(c => c.id === id).scriptId = null; });
  await runtime.start(id); await runtime.stop(id); assert.equal(f.store.snapshot().scripts.length, 1);
  await f.store.update(state => { state.characters.find(c => c.id === id).scriptId = null; }); f.cloud.code = null;
  await runtime.start(id);
  assert.equal(f.store.snapshot().characters.find(c => c.id === id).scriptId, null);
  assert.ok(runtime.logs.some(l => l.message.includes('je prázdný; postava poběží bez CODE')));
});
