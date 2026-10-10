import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { History, JOURNAL_LIMIT, SAMPLE_EVERY, buckets, downsample, summarizeHistory } from '../src/history.js';
import { eventTransitions, serverEventsView } from '../src/server-events.js';
import { Runtime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { configFromEnv } from '../src/config.js';

const temporary = async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test('journal entries and samples persist across restarts and are bounded', async t => {
  const directory = await temporary(t);
  let now = Date.UTC(2026, 9, 10, 12);
  const history = new History(directory, () => {}, () => now);
  await history.init();
  const emitted = [];
  history.on('entry', entry => emitted.push(entry));
  history.record({ type: 'start', characterId: 'id-1', name: 'Runner', message: 'Spuštěno.' });
  assert.equal(history.record({ type: 'unknown', message: 'x' }), null);
  assert.equal(history.sample('id-1', 'Runner', { level: 10, xp: 100, max_xp: 1000, gold: 5 }), true);
  now += 60_000;
  assert.equal(history.sample('id-1', 'Runner', { level: 10, xp: 200, max_xp: 1000, gold: 6 }), false, 'one sample per five minutes');
  now += SAMPLE_EVERY;
  history.sample('id-1', 'Runner', { level: 11, xp: 50, max_xp: 1200, gold: 9 });
  history.record({ type: 'level', characterId: 'id-1', name: 'Runner', message: 'Dosažen level 11.' });
  await history.close();
  assert.equal(emitted.length, 2);
  const restored = new History(directory, () => {}, () => now);
  await restored.init();
  assert.deepEqual(restored.query().entries.map(e => e.type), ['level', 'start']);
  assert.deepEqual(restored.query({ types: ['start'] }).entries.map(e => e.message), ['Spuštěno.']);
  assert.equal(restored.query({ after: 1 }).entries.length, 1);
  assert.equal(restored.query({ limit: 1 }).more, true);
  const [stats] = restored.stats(now - 86_400_000, now, 3_600_000);
  // 900 XP to finish level 10, then 50 into level 11.
  assert.equal(stats.name, 'Runner'); assert.equal(stats.xpGained, 950); assert.equal(stats.goldChange, 4); assert.equal(stats.levels, 1);
  assert.equal(stats.buckets.reduce((sum, b) => sum + b.xp, 0), 950);
  // Entries older than 30 days and samples older than 14 days are dropped.
  now += 31 * 86_400_000; restored.prune();
  assert.equal(restored.query().entries.length, 0); assert.equal(restored.stats(now - 86_400_000, now, 3_600_000).length, 0);
  for (let i = 0; i < JOURNAL_LIMIT + 5; i++) restored.record({ type: 'stop', message: String(i) });
  assert.equal(restored.journal.length, JOURNAL_LIMIT);
});

test('a damaged history file is set aside instead of stopping the server', async t => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'history.json'), '{broken');
  const messages = [];
  const history = new History(directory, message => messages.push(message));
  await history.init();
  assert.equal(history.journal.length, 0); assert.equal(messages.length, 1);
  assert.ok((await readdir(directory)).some(name => name.startsWith('history.json.broken-')));
  await writeFile(path.join(directory, 'history.json'), JSON.stringify({ journal: [{ id: 3, at: Date.now(), type: 'death', message: 'x', characterId: '../bad', realm: 'Mars 1' }, { id: 'x' }], samples: { 'id-1': { name: 'A', points: [[1, 2, 3], [Date.now(), 1, 2, 3, 4]] }, '../x': { points: [] } } }));
  const loaded = new History(directory); await loaded.init();
  assert.deepEqual(loaded.journal.map(e => [e.id, e.characterId, e.realm]), [[3, null, null]]);
  assert.equal(loaded.nextId, 4); assert.deepEqual([...loaded.samples.keys()], ['id-1']); assert.equal(loaded.samples.get('id-1').points.length, 1);
  await loaded.close();
  assert.match(await readFile(path.join(directory, 'history.json'), 'utf8'), /"version":1/);
});

test('long-term stats skip offline gaps and downsample charts', () => {
  const minute = 60_000, t0 = 1_000_000_000;
  const points = [[t0, 5, 0, 100, 10], [t0 + 5 * minute, 5, 40, 100, 20], [t0 + 10 * minute, 6, 10, 200, 30], [t0 + 120 * minute, 6, 90, 200, 0], [t0 + 125 * minute, 6, 100, 200, 5]];
  const summary = summarizeHistory(points, [{ type: 'death', at: t0 + minute }, { type: 'death', at: t0 - minute }], t0, t0 + 200 * minute);
  // 40 + (60 + 10) + 10; the 110 minute pause is offline and its XP is not counted.
  assert.equal(summary.xpGained, 120); assert.equal(summary.onlineMs, 15 * minute); assert.equal(summary.deaths, 1);
  assert.equal(summary.goldChange, -5); assert.deepEqual(summary.series.map(p => p.gap), [true, false, false, true, false]);
  assert.equal(summary.xpPerHour, 480);
  const bars = buckets(points, t0, t0 + 180 * minute, 60 * minute);
  assert.deepEqual(bars.map(b => b.xp), [110, 0, 10]);
  const long = Array.from({ length: 1000 }, (_, i) => ({ t: i, gap: i === 500 }));
  const reduced = downsample(long, 100);
  assert.ok(reduced.length <= 104); assert.equal(reduced[0].t, 0); assert.equal(reduced.at(-1).t, 999);
  assert.ok(reduced.some(p => p.t === 500) && reduced.some(p => p.t === 499));
});

test('server events are whitelisted and their starts and ends detected', () => {
  const view = serverEventsView({
    S: {
      franky: { live: true, hp: 50000.4, max_hp: 120000, map: 'level2w', x: -300, y: 40, target: 'Runner', secret: 'x' },
      icegolem: { live: false, spawn: '2026-10-10T20:00:00.000Z' },
      goobrawl: { end: 1791700000000 }, halloween: true, egghunt: false, anniversary: { active: false },
      schedule: { time_offset: 2, dailies: [6, 14, 99], nightlies: [20], night: true }, minutes: 5,
      '<img>': true, tiger: { live: true, target: '<b>' },
    },
    titles: { franky: 'Franky', goobrawl: 'Goo Brawl', icegolem: 'Ice Golem' },
  });
  assert.deepEqual(view.events.map(e => [e.key, e.kind, e.live]), [['franky', 'boss', true], ['tiger', 'boss', true], ['icegolem', 'boss', false], ['goobrawl', 'event', null], ['halloween', 'seasonal', null]]);
  const franky = view.events[0];
  assert.equal(franky.title, 'Franky'); assert.equal(franky.hp, 50000); assert.equal(franky.map, 'level2w'); assert.equal(franky.target, 'Runner'); assert.equal('secret' in franky, false);
  assert.equal(view.events[1].target, null);
  assert.equal(view.events[2].spawn, Date.parse('2026-10-10T20:00:00.000Z'));
  assert.deepEqual(view.schedule, { timeOffset: 2, dailies: [6, 14], nightlies: [20], night: true });
  assert.deepEqual(serverEventsView(null), { events: [], schedule: null });
  const later = serverEventsView({ S: { icegolem: { live: true }, goobrawl: { end: 1 }, halloween: true } });
  assert.deepEqual(eventTransitions(view, later).map(c => [c.key, c.change]), [['icegolem', 'start'], ['franky', 'end'], ['tiger', 'end']]);
});

test('the runtime journals realm events once per realm and notifies the selected ones', async t => {
  const directory = await temporary(t);
  const config = configFromEnv({ ADMIN_PASSWORD: 'fixture-password-long-enough', DATA_DIR: directory });
  const store = new Store(directory); await store.init();
  await store.update(state => { state.settings.notifyEvents = ['franky']; });
  const runtime = new Runtime(config, store);
  runtime.history = new History(null);
  const sent = [];
  runtime.notifier = { send: async text => { sent.push(text); return 1; }, status: () => ({ discord: true, telegram: false }) };
  const session = (id, name, S) => ({ id, status: 'running', character: { name, region: 'EU', server: 'I' }, server: serverEventsView({ S, titles: { franky: 'Franky', goobrawl: 'Goo Brawl' } }) });
  runtime.sessions.set('a', session('a', 'First', { franky: { live: false, spawn: 1 } }));
  runtime.sessions.set('b', session('b', 'Second', { franky: { live: true } }));
  runtime.updateServers();
  assert.equal(runtime.serverEvents()[0].via, 'First');
  assert.equal(runtime.history.journal.length, 0, 'the first reading after start is not a change');
  runtime.sessions.get('a').server = serverEventsView({ S: { franky: { live: true, map: 'level2w' }, goobrawl: { end: 5 } }, titles: { franky: 'Franky', goobrawl: 'Goo Brawl' } });
  runtime.updateServers();
  assert.deepEqual(runtime.history.journal.map(e => [e.type, e.realm, e.message]), [['event', 'EU I', 'EU I: Franky je tady (mapa level2w).'], ['event', 'EU I', 'EU I: Začala událost Goo Brawl.']]);
  assert.deepEqual(sent, ['🐉 EU I: Franky je tady (mapa level2w).']);
  runtime.sessions.clear(); runtime.updateServers();
  assert.deepEqual(runtime.serverEvents(), []);
});
