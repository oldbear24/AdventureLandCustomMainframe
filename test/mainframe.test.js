import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Runtime, characterUrl, withDeadline } from '../src/runtime.js';

const config = () => configFromEnv({ ADMIN_PASSWORD: 'test-password-is-long-enough', AL_AUTH_COOKIE: 'fake-user-fake-auth-secret' });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-test-'));
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config(), store);
  const app = createApp(config(), store, runtime);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  let cookie = '';
  async function request(endpoint, method = 'GET', body, options = {}) {
    const response = await fetch(origin + endpoint, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, ...options.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, response, data: await response.json() };
  }
  async function login() {
    const result = await request('/api/login', 'POST', { password: config().password });
    assert.equal(result.status, 200); cookie = result.response.headers.get('set-cookie').split(';')[0];
  }
  return { directory, store, runtime, request, login };
}
test('configuration rejects missing password and invalid limits', () => {
  assert.throws(() => configFromEnv({}), /ADMIN_PASSWORD/);
  assert.throws(() => configFromEnv({ ADMIN_PASSWORD: config().password, MAX_CHARACTERS: '9' }), /MAX_CHARACTERS/);
  assert.throws(() => configFromEnv({ ADMIN_PASSWORD: config().password, PUBLIC_ORIGIN: 'https://example.com/path' }), /PUBLIC_ORIGIN/);
});
test('dashboard requires login, session is HttpOnly, logout revokes access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/dashboard')).status, 401);
  const login = await f.request('/api/login', 'POST', { password: config().password });
  assert.match(login.response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.response.headers.get('set-cookie'), /SameSite=Strict/);
  await f.login();
  const dashboard = await f.request('/api/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(JSON.stringify(dashboard.data).includes(config().authCookie), false);
  assert.equal(dashboard.response.headers.get('cache-control'), 'no-store');
  await f.request('/api/logout', 'POST', {});
  assert.equal((await f.request('/api/dashboard')).status, 401);
});
test('foreign Origin and non-JSON mutations are rejected', async t => {
  const f = await fixture(t); await f.login();
  assert.equal((await f.request('/api/scripts', 'POST', { name: 'a', source: '' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/scripts', 'POST', { name: 'a', source: '' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.store.snapshot().scripts.length, 0);
});
test('login is rate limited after ten failed attempts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await f.request('/api/login', 'POST', { password: 'wrong' })).status, 401);
  const result = await f.request('/api/login', 'POST', { password: config().password });
  assert.equal(result.status, 429); assert.ok(Number(result.response.headers.get('retry-after')) > 0);
});
test('script and character CRUD persist and reject invalid references and duplicates', async t => {
  const f = await fixture(t); await f.login();
  const script = (await f.request('/api/scripts', 'POST', { name: 'farm', source: 'console.log("hello")' })).data;
  assert.equal((await f.request('/api/scripts', 'POST', { name: 'broken', source: 'function {' })).status, 400);
  assert.equal((await f.request('/api/characters', 'POST', { name: '../secret', region: 'EU', server: 'I' })).status, 400);
  const character = (await f.request('/api/characters', 'POST', { name: 'Warrior', region: 'EU', server: 'I', scriptId: script.id, autoStart: true })).data;
  assert.equal((await f.request('/api/characters', 'POST', { name: 'warrior', region: 'EU', server: 'I' })).status, 409);
  assert.equal((await f.request(`/api/scripts/${script.id}`, 'DELETE', {})).status, 409);
  assert.equal((await f.request(`/api/scripts/${script.id}`, 'PUT', { name: 'farm v2', source: 'console.log("changed")' })).status, 200);
  const restored = new Store(f.directory); await restored.init();
  assert.equal(restored.snapshot().characters[0].name, 'Warrior');
  assert.equal(restored.snapshot().scripts[0].source, 'console.log("changed")');
  assert.equal((await f.request(`/api/characters/${character.id}/stop`, 'POST', {})).status, 200);
  assert.equal(f.store.snapshot().characters[0].autoStart, false);
  assert.equal((await f.request(`/api/characters/${character.id}`, 'DELETE', {})).status, 200);
  assert.equal((await f.request(`/api/scripts/${script.id}`, 'DELETE', {})).status, 200);
});
test('store serializes concurrent writes and survives rejected updates', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.store.update(state => { state.scripts.push({ id: crypto.randomUUID(), name: `script ${i}`, source: '', updatedAt: new Date().toISOString() }); })));
  await assert.rejects(f.store.update(state => { state.version = 99; }));
  await f.store.update(state => { state.scripts[0].name = 'still works'; });
  const onDisk = JSON.parse(await readFile(path.join(f.directory, 'state.json'), 'utf8'));
  assert.equal(onDisk.scripts.length, 20); assert.equal(onDisk.version, 1); assert.equal(onDisk.scripts[0].name, 'still works');
});
test('runtime serializes duplicate starts, retries disconnect, and stop cancels retries', async t => {
  const f = await fixture(t);
  const id = crypto.randomUUID();
  await f.store.update(state => state.characters.push({ id, name: 'Warrior', region: 'EU', server: 'I', scriptId: null, autoStart: false }));
  let starts = 0, closed = 0;
  f.runtime.connect = async session => {
    starts++; session.context = { close: async () => { closed++; } };
    session.page = { evaluate: async () => null }; session.status = 'running'; session.attempts = 0;
  };
  await Promise.all([f.runtime.start(id), f.runtime.start(id)]); assert.equal(starts, 1);
  await f.runtime.tick(); assert.equal(f.runtime.snapshot()[0].status, 'reconnecting');
  assert.ok(f.runtime.snapshot()[0].nextRetry > Date.now());
  f.runtime.sessions.get(id).nextRetry = 0; await f.runtime.tick(); assert.equal(starts, 2);
  await f.runtime.stop(id); await f.runtime.tick(); assert.equal(starts, 2); assert.equal(closed, 1); assert.equal(f.runtime.snapshot().length, 0);
});
test('missing game credentials reject start without reserving a session', async t => {
  const f = await fixture(t); const id = crypto.randomUUID();
  await f.store.update(state => state.characters.push({ id, name: 'Warrior', region: 'EU', server: 'I', scriptId: null, autoStart: false }));
  f.runtime.config.authCookie = '';
  await assert.rejects(f.runtime.start(id), /AL_AUTH_COOKIE/); assert.equal(f.runtime.snapshot().length, 0);
});
test('active configuration cannot be changed while runtime owns the character', async t => {
  const f = await fixture(t); await f.login();
  const character = (await f.request('/api/characters', 'POST', { name: 'Warrior', region: 'EU', server: 'I' })).data;
  f.runtime.sessions.set(character.id, { id: character.id });
  assert.equal((await f.request(`/api/characters/${character.id}`, 'PUT', { name: 'Warrior', region: 'US', server: 'II' })).status, 409);
});
test('redaction and deadline protect logs and a stuck game page', async t => {
  const f = await fixture(t);
  f.runtime.log(null, 'error', `auth=${config().authCookie}; token=fake-auth-secret`);
  assert.equal(f.runtime.logs[0].message.includes(config().authCookie), false);
  assert.equal(f.runtime.redact('user_auth=user-fake-auth-secret').includes('user-fake-auth-secret'), false);
  for (let i = 0; i < 1100; i++) f.runtime.log(null, 'info', 'bounded');
  assert.equal(f.runtime.logs.length, 1000);
  await assert.rejects(withDeadline(new Promise(() => {}), 10), /časovém limitu/);
  const url = new URL(characterUrl({ name: 'Warrior', region: 'EU', server: 'I' }));
  assert.equal(url.origin, 'https://adventure.land'); assert.equal(url.searchParams.get('no_graphics'), 'true'); assert.equal(url.searchParams.has('code'), false);
});
test('the actual Node 22 startup command serves the panel without game credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-startup-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/bootstrap.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, ADMIN_PASSWORD: config().password, AL_AUTH_COOKIE: '', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  });
  const output = await withDeadline(new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('Adventure Land Mainframe:')) resolve(text); });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', reject); child.on('exit', code => reject(new Error(`Startup exited ${code}: ${text}`)));
  }), 10_000);
  assert.match(output, /Adventure Land Mainframe/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200); assert.match(await response.text(), /Vlastní mainframe/);
});
