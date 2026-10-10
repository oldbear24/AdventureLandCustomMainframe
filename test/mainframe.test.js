import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import https from 'node:https';
import { GameAccount } from '../src/game-account.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Runtime, characterUrl, withDeadline } from '../src/runtime.js';

const config = () => configFromEnv({ ADMIN_PASSWORD: 'test-password-is-long-enough', AL_AUTH_COOKIE: 'fake-user-fake-auth-secret' });
async function fixture(t, requestGame = async () => { throw new Error('Live game requests are disabled in tests'); }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-test-'));
  const store = new Store(directory); await store.init();
  const configuration = config(); configuration.dataDir = directory;
  const runtime = new Runtime(configuration, store);
  const account = new GameAccount(configuration, runtime, requestGame); await account.init();
  const app = createApp(configuration, store, runtime, account);
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
  return { directory, store, runtime, account, configuration, request, login };
}
test('configuration rejects missing password and invalid limits', () => {
  assert.throws(() => configFromEnv({}), /ADMIN_PASSWORD/);
  assert.throws(() => configFromEnv({ ADMIN_PASSWORD: config().password, MAX_CHARACTERS: '9' }), /MAX_CHARACTERS/);
  assert.throws(() => configFromEnv({ ADMIN_PASSWORD: config().password, PUBLIC_ORIGIN: 'https://example.com/path' }), /PUBLIC_ORIGIN/);
});
test('dashboard requires login, session is HttpOnly, logout revokes access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/dashboard')).status, 401);
  assert.equal((await f.request('/api/login', 'POST', { username: 'someone-else', password: config().password })).status, 401);
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
  assert.equal(f.runtime.logs.length, 200);
  await assert.rejects(withDeadline(new Promise(() => {}), 10), /časovém limitu/);
  const url = new URL(characterUrl({ name: 'Warrior', region: 'EU', server: 'I' }));
  assert.equal(url.origin, 'https://adventure.land'); assert.equal(url.searchParams.get('no_graphics'), 'true'); assert.equal(url.searchParams.has('code'), false);
});
test('the actual Node 22 startup command generates a certificate and serves the panel only over HTTPS', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-startup-'));
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['src/bootstrap.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, ADMIN_PASSWORD: config().password, AL_AUTH_COOKIE: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '', TLS_HOSTNAMES: '', PUBLIC_ORIGIN: '', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: directory },
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
  assert.ok(output.includes(`https://127.0.0.1:${port}`));
  const ca = await readFile(path.join(directory, 'tls', 'cert.pem'));
  const get = (endpoint, options = {}) => new Promise((resolve, reject) => {
    https.get(`https://127.0.0.1:${port}${endpoint}`, { ca, ...options }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text }));
    }).on('error', reject);
  });
  assert.equal((await get('/healthz')).status, 200);
  const response = await get('/');
  assert.equal(response.status, 200); assert.match(response.text, /Vlastní mainframe/);
  await assert.rejects(get('/healthz', { ca: undefined }), /self-signed|self signed/i);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});
test('game account login only authenticates existing accounts and stores an encrypted session without the password', async t => {
  let calls = 0;
  const f = await fixture(t, async (url, options) => {
    calls++; assert.equal(url, 'https://adventure.land/api/signup_or_login');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { email: 'player@example.com', password: 'my-game-password', only_login: true });
    return new Response(JSON.stringify({ success: true, user: 'game-user', auth: 'a-realistic-long-fixture-token' }), { status: 200 });
  });
  assert.equal((await f.request('/api/account')).status, 401);
  assert.equal((await f.request('/api/account/login', 'POST', { email: 'player@example.com', password: 'my-game-password' })).status, 401);
  assert.equal(calls, 0); await f.login();
  const login = await f.request('/api/account/login', 'POST', { email: 'player@example.com', password: 'my-game-password' });
  assert.equal(login.status, 200); assert.equal(login.data.configured, true); assert.equal(calls, 1);
  assert.equal(JSON.stringify(login.data).includes('fixture-token'), false);
  assert.equal(f.configuration.authCookie, 'game-user-a-realistic-long-fixture-token');
  const disk = await readFile(path.join(f.directory, 'account.enc.json'), 'utf8');
  assert.equal(disk.includes('my-game-password'), false); assert.equal(disk.includes('fixture-token'), false); assert.equal(disk.includes('player@example.com'), false);
  const restoredConfig = { ...f.configuration, authCookie: '' };
  const restored = new GameAccount(restoredConfig, f.runtime); await restored.init();
  assert.equal(restoredConfig.authCookie, f.configuration.authCookie); assert.equal(restored.status().email, 'player@example.com');
});
test('failed game login preserves previous credentials and does not leak upstream secrets', async t => {
  const f = await fixture(t, async () => new Response(JSON.stringify({ failed: true, reason: 'wrong_password', auth: 'should-not-leak' }), { status: 401 }));
  await f.login(); const original = f.configuration.authCookie;
  const result = await f.request('/api/account/login', 'POST', { email: 'player@example.com', password: 'wrong-password' });
  assert.equal(result.status, 401); assert.equal(f.configuration.authCookie, original);
  assert.equal(JSON.stringify(result.data).includes('should-not-leak'), false);
});
test('account change is blocked while a character is active; disconnect stops it and persists logout', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw new Error('Must not call upstream'); }); await f.login();
  const character = (await f.request('/api/characters', 'POST', { name: 'Warrior', region: 'EU', server: 'I', autoStart: true })).data;
  f.runtime.sessions.set(character.id, { id: character.id });
  assert.equal((await f.request('/api/account/login', 'POST', { email: 'player@example.com', password: 'password' })).status, 409);
  assert.equal(calls, 0);
  const result = await f.request('/api/account/disconnect', 'POST', {});
  assert.equal(result.status, 200); assert.equal(result.data.configured, false); assert.equal(f.runtime.sessions.size, 0);
  assert.equal(f.store.snapshot().characters[0].autoStart, false);
  const restarted = { ...f.configuration, authCookie: 'old-env-cookie' };
  await new GameAccount(restarted, f.runtime).init(); assert.equal(restarted.authCookie, '');
});
test('manual game cookie is encrypted and excluded from API responses', async t => {
  const f = await fixture(t); await f.login();
  const cookie = 'fixture-account-long-secret-cookie';
  const result = await f.request('/api/account/cookie', 'POST', { cookie });
  assert.equal(result.status, 200); assert.equal(f.configuration.authCookie, cookie);
  assert.equal(JSON.stringify((await f.request('/api/dashboard')).data).includes(cookie), false);
  assert.equal((await readFile(path.join(f.directory, 'account.enc.json'), 'utf8')).includes(cookie), false);
  assert.equal((await f.request('/api/account/cookie', 'POST', { cookie: 'auth=x; other=y' })).status, 400);
});
test('tampering with a saved game session fails closed', async t => {
  const f = await fixture(t); await f.account.setCookie('fixture-account-long-secret-cookie');
  const file = path.join(f.directory, 'account.enc.json');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const data = Buffer.from(stored.data, 'base64'); data[0] ^= 1; stored.data = data.toString('base64');
  await writeFile(file, JSON.stringify(stored));
  const restarted = { ...f.configuration, authCookie: '' };
  await assert.rejects(new GameAccount(restarted, f.runtime).init(), /dešifrovat/);
  assert.equal(restarted.authCookie, '');
});
