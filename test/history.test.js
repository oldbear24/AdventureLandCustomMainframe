import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

test('journal entries, samples and logs persist across restarts and are bounded', async t => {
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
  history.addLog({ at: new Date(now).toISOString(), characterId: 'id-1', level: 'error', message: 'Boom' });
  await history.close();
  assert.equal(emitted.length, 2);
  assert.ok((await readdir(directory)).includes('history.db'));
  const restored = new History(directory, () => {}, () => now);
  await restored.init();
  t.after(() => restored.close());
  assert.deepEqual(restored.query().entries.map(e => e.type), ['level', 'start']);
  assert.deepEqual(restored.query({ types: ['start'] }).entries.map(e => e.message), ['Spuštěno.']);
  assert.equal(restored.query({ after: 1 }).entries.length, 1);
  assert.equal(restored.query({ limit: 1 }).more, true);
  assert.deepEqual(restored.logs().entries.map(e => [e.characterId, e.level, e.message]), [['id-1', 'error', 'Boom']]);
  const [stats] = restored.stats(now - 86_400_000, now, 3_600_000);
  // 900 XP to finish level 10, then 50 into level 11.
  assert.equal(stats.name, 'Runner'); assert.equal(stats.xpGained, 950); assert.equal(stats.goldChange, 4); assert.equal(stats.levels, 1);
  assert.equal(stats.buckets.reduce((sum, b) => sum + b.xp, 0), 950);
  // The hourly totals give the same XP for long ranges.
  const [yearly] = restored.stats(now - 365 * 86_400_000, now + 3_600_000, 7 * 86_400_000);
  assert.equal(yearly.xpGained, 950); assert.equal(yearly.onlineMs, SAMPLE_EVERY + 60_000); assert.equal(yearly.levelEnd, 11);
  assert.deepEqual(restored.usage().journal, 2);
  // Logs go after a week, five-minute samples after a month, the journal and hourly totals stay longer.
  now += 8 * 86_400_000; restored.prune();
  assert.equal(restored.logs().total, 0); assert.equal(restored.query().entries.length, 2);
  now += 30 * 86_400_000; restored.prune();
  assert.equal(restored.stats(now - 7 * 86_400_000, now, 86_400_000).length, 0);
  assert.equal(restored.stats(now - 365 * 86_400_000, now, 7 * 86_400_000)[0].xpGained, 950);
  assert.equal(restored.query().entries.length, 2);
  now += 330 * 86_400_000; restored.prune();
  assert.equal(restored.query().entries.length, 0);
  assert.equal(JOURNAL_LIMIT, 200_000);
});

test('the old history.json is migrated once and kept aside', async t => {
  const directory = await temporary(t);
  const now = Date.UTC(2026, 9, 10, 12), minute = 60_000;
  const points = [[now - 30 * minute, 5, 0, 100, 10], [now - 25 * minute, 5, 40, 100, 20], [now - 20 * minute, 6, 10, 200, 30], [now - 10 * minute, 6, 20, 200, 30]];
  await writeFile(path.join(directory, 'history.json'), JSON.stringify({
    version: 1,
    journal: [{ id: 7, at: now - 40 * minute, type: 'start', characterId: 'id-1', name: 'Runner', message: 'Spuštěno.', realm: null }, { id: 'bad' }, { id: 9, at: now - minute, type: 'death', characterId: '../bad', message: 'x', realm: 'Mars 1' }],
    samples: { 'id-1': { name: 'Runner', points: [...points, [1, 2, 3]] }, '../x': { points: [] } },
  }));
  const messages = [];
  const history = new History(directory, message => messages.push(message), () => now);
  await history.init();
  assert.match(messages[0], /2 záznamů deníku a 4 vzorků/);
  const files = await readdir(directory);
  assert.ok(files.includes('history.json.migrated')); assert.ok(!files.includes('history.json'));
  assert.deepEqual(history.query().entries.map(e => [e.type, e.characterId, e.realm]), [['death', null, null], ['start', 'id-1', null]]);
  // 40 + (60 + 10); the ten-minute step to the last sample is still online and adds 10 more.
  const [detailed] = history.stats(now - 86_400_000, now, 3_600_000);
  assert.equal(detailed.xpGained, 120); assert.equal(detailed.samples, 4);
  const [hourly] = history.stats(now - 30 * 86_400_000, now, 86_400_000);
  assert.equal(hourly.xpGained, 120); assert.equal(hourly.goldChange, 20);
  // New entries continue after the migrated ones.
  assert.ok(history.record({ type: 'stop', message: 'x' }).id > 2);
  await history.close();
  const again = new History(directory, message => messages.push(message), () => now);
  await again.init();
  assert.equal(again.query().total, 3, 'the migration runs only once'); assert.equal(messages.length, 1);
  await again.close();
});

test('a damaged history file is set aside instead of stopping the server', async t => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'history.json'), '{broken');
  await writeFile(path.join(directory, 'history.db'), 'this is not a database, just some text long enough to fill a header '.repeat(10));
  const messages = [];
  const history = new History(directory, message => messages.push(message));
  await history.init();
  assert.equal(history.query().total, 0); assert.equal(messages.length, 2);
  const files = await readdir(directory);
  assert.ok(files.some(name => name.startsWith('history.json.broken-'))); assert.ok(files.some(name => name.startsWith('history.db.broken-')));
  history.record({ type: 'stop', message: 'x' });
  await history.close();
  const reopened = new History(directory); await reopened.init();
  assert.equal(reopened.query().total, 1);
  await reopened.close();
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
  runtime.history = new History(null); await runtime.history.init();
  t.after(() => runtime.history.close());
  const sent = [];
  runtime.notifier = { send: async text => { sent.push(text); return 1; }, status: () => ({ discord: true, telegram: false }) };
  const session = (id, name, S) => ({ id, status: 'running', character: { name, region: 'EU', server: 'I' }, server: serverEventsView({ S, titles: { franky: 'Franky', goobrawl: 'Goo Brawl' } }) });
  runtime.sessions.set('a', session('a', 'First', { franky: { live: false, spawn: 1 } }));
  runtime.sessions.set('b', session('b', 'Second', { franky: { live: true } }));
  runtime.updateServers();
  assert.equal(runtime.serverEvents()[0].via, 'First');
  assert.equal(runtime.history.query().total, 0, 'the first reading after start is not a change');
  runtime.sessions.get('a').server = serverEventsView({ S: { franky: { live: true, map: 'level2w' }, goobrawl: { end: 5 } }, titles: { franky: 'Franky', goobrawl: 'Goo Brawl' } });
  runtime.updateServers();
  assert.deepEqual(runtime.history.query().entries.reverse().map(e => [e.type, e.realm, e.message]), [['event', 'EU I', 'EU I: Franky je tady (mapa level2w).'], ['event', 'EU I', 'EU I: Začala událost Goo Brawl.']]);
  assert.deepEqual(sent, ['🐉 EU I: Franky je tady (mapa level2w).']);
  runtime.sessions.clear(); runtime.updateServers();
  assert.deepEqual(runtime.serverEvents(), []);
});
test('last seen is the newest sample or start, connection or stop of each character', async t => {
  let now = 1_000_000;
  const history = new History(null, () => {}, () => now);
  await history.init(); t.after(() => history.close());
  history.record({ type: 'start', characterId: 'a', message: 'Spuštěno.' });
  now += 60_000; history.sample('a', 'A', { level: 1, xp: 0, max_xp: 10, gold: 0 });
  now += 60_000; history.record({ type: 'level', characterId: 'a', message: 'Level.' });
  history.record({ type: 'stop', characterId: 'b', message: 'Zastaveno.' });
  history.record({ type: 'event', message: 'Boss.' });
  assert.deepEqual(history.lastSeen(), { a: 1_060_000, b: 1_120_000 });
});
