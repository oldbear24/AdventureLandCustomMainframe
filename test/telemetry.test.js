import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { addSample, alertsFor, extrasView, isActivity, summarizeStats } from '../src/telemetry.js';
import { Notifier, notifierConfig } from '../src/notifier.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';
import { createApp } from '../src/app.js';

const minute = 60_000;
test('XP and gold rates span level-ups and the window keeps one hour', () => {
  const samples = [], t0 = 1_000_000;
  addSample(samples, { level: 10, xp: 800, max_xp: 1000, gold: 100 }, t0);
  addSample(samples, { level: 10, xp: 900, max_xp: 1000, gold: 50 }, t0 + 30_000);
  assert.equal(samples.length, 1, 'samples are taken at most once a minute');
  addSample(samples, { level: 11, xp: 300, max_xp: 2000, gold: 400 }, t0 + 10 * minute);
  const stats = summarizeStats(samples, { level: 11, xp: 500, max_xp: 2000, gold: 700 }, t0 + 20 * minute);
  assert.equal(stats.xpGained, 200 + 300 + 200);
  assert.equal(stats.goldChange, 600);
  assert.equal(stats.xpPerHour, 700 * 3);
  assert.equal(stats.goldPerHour, 1800);
  assert.equal(stats.etaMs, Math.round(1500 / 2100 * 3_600_000));
  assert.deepEqual(stats.series.map(p => p.xp), [0, 500, 700]);
  assert.equal(summarizeStats(samples.slice(0, 1), { level: 10, xp: 850, max_xp: 1000, gold: 100 }, t0 + minute).xpPerHour, null, 'no rate before two minutes');
  for (let i = 1; i <= 90; i++) addSample(samples, { level: 11, xp: 500 + i, max_xp: 2000, gold: 700 }, t0 + (20 + i) * minute);
  assert.ok(samples.at(-1).t - samples[0].t <= 61 * minute);
});
test('extras from the game page are whitelisted', () => {
  const view = extrasView({
    max_xp: 1000.4, esize: 3, isize: 42, potions: { hp: 12, mp: -1 }, lastSkillAt: 5,
    conditions: [{ key: 'poisoned', name: 'Poisoned', kind: 'debuff', ms: 5000, secret: 'x' }, { key: '<img>', name: 'x' }, { key: 'mluck', name: 'M'.repeat(200), kind: 'evil' }],
    skills: [{ key: 'supershot', name: 'Super Shot', ms: -40, cooldown: 30000 }, { key: 'bad key' }],
    party: { leader: 'Leader', members: [{ name: 'Leader', ctype: 'priest', level: 60, map: 'main', x: 1, y: 2, auth: 'secret' }, { name: '<script>' }] },
  });
  assert.equal(view.max_xp, 1000); assert.deepEqual(view.potions, { hp: 12, mp: 0 });
  assert.deepEqual(view.conditions, [{ key: 'poisoned', name: 'Poisoned', kind: 'debuff', ms: 5000 }, { key: 'mluck', name: 'mluck', kind: 'neutral', ms: null }]);
  assert.deepEqual(view.skills, [{ key: 'supershot', name: 'Super Shot', ms: 0, cooldown: 30000 }]);
  assert.deepEqual(view.party, { leader: 'Leader', members: [{ name: 'Leader', ctype: 'priest', level: 60, map: 'main', x: 1, y: 2 }] });
  assert.equal(extrasView({ party: { leader: 'x y' } }).party, null);
});
test('activity and alerts cover death, idling, reconnects, potions and paused CODE', () => {
  const base = { x: 0, y: 0, xp: 1, gold: 1, level: 1, target: null, map: 'main', lastSkillAt: 10 };
  assert.equal(isActivity(base, { ...base, x: 1 }), false);
  assert.equal(isActivity(base, { ...base, x: 5 }), true);
  assert.equal(isActivity(base, { ...base, lastSkillAt: 11 }), true);
  assert.equal(isActivity(base, { ...base, xp: 2 }), true);
  const now = 10 * minute, character = { idleMinutes: 5, potionMin: 10 };
  const running = { status: 'running', attempts: 0, lastActivityAt: now - 6 * minute, state: { rip: false, potions: { hp: 50, mp: 3 } } };
  assert.deepEqual(alertsFor(running, character, now).map(a => a.type), ['idle', 'potions']);
  assert.deepEqual(alertsFor({ ...running, state: { rip: true, potions: { hp: 50, mp: 50 } } }, character, now).map(a => a.type), ['dead']);
  assert.deepEqual(alertsFor(running, { idleMinutes: 0, potionMin: 0 }, now), []);
  assert.deepEqual(alertsFor({ status: 'reconnecting', attempts: 1 }, character, now), []);
  assert.deepEqual(alertsFor({ status: 'reconnecting', attempts: 3, error: 'boom', code: { error: 'x' } }, character, now).map(a => a.type), ['reconnect', 'code']);
});
test('notifier validates targets, never leaks secrets and limits volume', async () => {
  assert.throws(() => notifierConfig({ DISCORD_WEBHOOK_URL: 'https://evil.example/api/webhooks/1/abc' }), /DISCORD_WEBHOOK_URL/);
  assert.throws(() => notifierConfig({ TELEGRAM_BOT_TOKEN: `123456:${'a'.repeat(35)}` }), /TELEGRAM_CHAT_ID/);
  const webhook = `https://discord.com/api/webhooks/123/${'s'.repeat(40)}`, token = `123456:${'t'.repeat(35)}`;
  const config = notifierConfig({ DISCORD_WEBHOOK_URL: webhook, TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: '-100200' });
  const calls = [], logs = [];
  const notifier = new Notifier(config, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.includes('telegram')) return new Response('{}', { status: 401 });
    return new Response(null, { status: 204 });
  }, message => logs.push(message));
  assert.equal(await notifier.send('@everyone Lyssara umřela'), 1);
  assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  assert.equal(calls[1].body.chat_id, '-100200');
  assert.deepEqual(logs, ['Telegram upozornění selhalo: HTTP 401.']);
  assert.equal(logs.join('').includes(token) || logs.join('').includes(webhook), false);
  for (let i = 0; i < 40; i++) await notifier.send('spam');
  assert.equal(calls.length, 60, 'at most 30 messages an hour');
  assert.equal(await new Notifier({}).send('x'), 0);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-telemetry-'));
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory, AL_AUTH_COOKIE: 'fake-user-fake-auth-secret' });
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config, store);
  const app = createApp(config, store, runtime);
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
  return { request, runtime, store };
}
test('tick reports telemetry, raises alerts once and reloads idle CODE when enabled', async t => {
  const f = await fixture(t);
  const sent = [];
  f.runtime.notifier = { send: async text => { sent.push(text); return 1; }, status: () => ({ discord: true, telegram: false }), configured: () => true };
  const character = { id: '6f1c1a52-58a2-4a39-9a43-6d4f0f0d1a11', name: 'Lyssara', region: 'EU', server: 'IV', scriptId: null, autoStart: false, idleMinutes: 1, autoReloadIdle: true, potionMin: 5 };
  await f.store.update(state => { state.characters.push(character); });
  let reloads = 0;
  const raw = { name: 'Lyssara', ctype: 'ranger', level: 49, hp: 10, max_hp: 10, mp: 5, max_mp: 5, gold: 100, xp: 50, map: 'main', x: 0, y: 0, rip: false, nearby: [], target: null, extras: { max_xp: 100, potions: { hp: 2, mp: 9 }, conditions: [{ key: 'cursed', name: 'Cursed', kind: 'debuff', ms: 1000 }], skills: [{ key: 'attack', name: 'Attack', ms: 300 }], party: null } };
  const session = { id: character.id, character, status: 'running', attempts: 0, code: { slot: '1' }, page: { evaluate: async () => structuredClone(raw) } };
  f.runtime.loadScript = async () => { reloads++; };
  f.runtime.sessions.set(character.id, session);
  await f.runtime.tick(); await f.runtime.tick();
  let snapshot = f.runtime.snapshot()[0];
  assert.deepEqual(snapshot.alerts.map(a => a.type), ['potions']);
  assert.equal(snapshot.state.conditions[0].kind, 'debuff');
  assert.equal(snapshot.state.extras, undefined);
  assert.equal(sent.length, 1, 'an alert is sent once while it lasts');
  assert.match(sent[0], /Lyssara \(EU IV\)/);
  session.lastActivityAt -= 2 * minute;
  await f.runtime.tick();
  snapshot = f.runtime.snapshot()[0];
  assert.equal(reloads, 1); assert.equal(snapshot.autoReloads, 1);
  assert.ok(snapshot.idleMs < minute, 'reload restarts the idle window');
  raw.rip = true; await f.runtime.tick();
  assert.deepEqual(f.runtime.snapshot()[0].alerts.map(a => a.type), ['dead', 'potions']);
  assert.equal(sent.length, 2);
  const dashboard = await f.request('/api/dashboard');
  assert.equal(dashboard.data.config.notifications.discord, true);
  assert.ok(Number.isFinite(dashboard.data.now));
  f.runtime.sessions.clear();
});
test('batch actions stop all, move servers and report start failures per character', async t => {
  const f = await fixture(t);
  const ids = ['6f1c1a52-58a2-4a39-9a43-6d4f0f0d1a21', '6f1c1a52-58a2-4a39-9a43-6d4f0f0d1a22'];
  await f.store.update(state => {
    state.characters.push({ id: ids[0], name: 'Alpha', region: 'EU', server: 'I', scriptId: null, autoStart: true });
    state.characters.push({ id: ids[1], name: 'Beta', region: 'EU', server: 'I', scriptId: null, autoStart: true });
  });
  const starts = [];
  f.runtime.startInternal = async id => {
    if (id === ids[1]) throw new Error('Postava už je online.');
    starts.push(id); f.runtime.sessions.set(id, { id, status: 'running', character: f.store.snapshot().characters.find(c => c.id === id) });
  };
  f.runtime.stopInternal = async id => { f.runtime.sessions.delete(id); };
  assert.equal((await f.request('/api/characters/batch', 'POST', { action: 'move', region: 'US' })).status, 400);
  const started = await f.request('/api/characters/batch', 'POST', { action: 'start' });
  assert.deepEqual(started.data.results.map(r => [r.name, r.ok, r.error]), [['Alpha', true, null], ['Beta', false, 'Postava už je online.']]);
  const moved = await f.request('/api/characters/batch', 'POST', { action: 'move', ids: [ids[0]], region: 'US', server: 'II' });
  assert.deepEqual(moved.data.results.map(r => [r.name, r.ok]), [['Alpha', true]]);
  assert.deepEqual(starts, [ids[0], ids[0]], 'a running character is restarted on the new server');
  const alpha = f.store.snapshot().characters.find(c => c.id === ids[0]);
  assert.deepEqual([alpha.region, alpha.server, alpha.autoStart], ['US', 'II', true]);
  assert.equal(f.store.snapshot().characters.find(c => c.id === ids[1]).server, 'I');
  const stopped = await f.request('/api/characters/batch', 'POST', { action: 'stop' });
  assert.equal(stopped.data.results.length, 2);
  assert.equal(f.runtime.sessions.size, 0);
  assert.equal(f.store.snapshot().characters.every(c => !c.autoStart), true);
  assert.equal((await f.request('/api/notifications/test', 'POST', {})).status, 409);
});
