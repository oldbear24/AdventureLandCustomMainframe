// Persistent history in the data volume (SQLite, history.db): a journal of notable events, long-term XP/gold
// samples with hourly totals for older periods, and the game and CODE logs. All of it survives restarts.
// The former history.json is imported once on the first start and kept as history.json.migrated.
import { DatabaseSync } from 'node:sqlite';
import { readFile, rename } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const JOURNAL_TYPES = ['start', 'connected', 'disconnected', 'stop', 'death', 'level', 'code', 'code_error', 'alert', 'move', 'event'];
export const JOURNAL_DAYS = 365;
export const JOURNAL_LIMIT = 200_000;
export const SAMPLE_EVERY = 5 * 60_000;
// Five-minute samples are kept for a month; hourly totals made from them for two years.
export const SAMPLE_DAYS = 31;
export const HOURLY_DAYS = 730;
export const LOG_DAYS = 7;
export const LOG_STORED = 200_000;
// A longer pause between two samples means the character was not running in between.
export const SAMPLE_GAP = 3 * SAMPLE_EVERY;
// Ranges longer than this are computed from the hourly totals instead of the five-minute samples.
export const DETAIL_SPAN = 14 * 86_400_000;
const DAY = 86_400_000, HOUR = 3_600_000;
const SEEN_TYPES = ['start', 'connected', 'disconnected', 'stop'];
const PRUNE_EVERY = HOUR;
const ID = /^[a-zA-Z0-9-]{1,64}$/;
const REALM = /^(EU|US|ASIA) [a-zA-Z0-9_-]{1,24}$/;
const int = value => Number.isFinite(value) ? Math.round(value) : 0;

function validEntry(e) {
  return e && Number.isSafeInteger(e.id) && Number.isFinite(e.at) && JOURNAL_TYPES.includes(e.type) && typeof e.message === 'string';
}
function entryView(e) {
  return {
    id: e.id, at: e.at, type: e.type, characterId: typeof e.characterId === 'string' && ID.test(e.characterId) ? e.characterId : null,
    name: typeof e.name === 'string' ? e.name.slice(0, 32) : null, message: e.message.slice(0, 500),
    realm: typeof e.realm === 'string' && REALM.test(e.realm) ? e.realm : null,
  };
}
const journalRow = r => ({ id: r.id, at: r.at, type: r.type, characterId: r.character_id, name: r.name, message: r.message, realm: r.realm });
const logRow = r => ({ id: r.id, at: r.at, characterId: r.character_id, level: r.level, message: r.message });
// XP gained between two consecutive samples, across a level-up.
const xpBetween = (a, b) => b[1] === a[1] ? Math.max(0, b[2] - a[2]) : b[1] > a[1] ? Math.max(0, (a[3] || a[2]) - a[2]) + b[2] : 0;
// LIKE pattern for a plain-text search.
const like = text => `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;

// XP gained across level-ups, gold change, levels, deaths and time online over [from, to].
export function summarizeHistory(points, entries, from, to) {
  const inside = points.filter(p => p[0] >= from && p[0] <= to);
  let xp = 0, online = 0;
  const series = [];
  for (let i = 0; i < inside.length; i++) {
    const [t, level, , , gold] = inside[i], previous = inside[i - 1];
    if (previous && t - previous[0] <= SAMPLE_GAP) { online += t - previous[0]; xp += xpBetween(previous, inside[i]); }
    // A gap starts a new line segment in the charts.
    series.push({ t, xp, gold: gold - (inside[0]?.[4] ?? 0), level, gap: !previous || t - previous[0] > SAMPLE_GAP });
  }
  const first = inside[0], last = inside.at(-1);
  const count = type => entries.filter(e => e.type === type && e.at >= from && e.at <= to).length;
  return {
    from, to, samples: inside.length, onlineMs: online, xpGained: xp,
    goldChange: first && last ? last[4] - first[4] : 0, levelStart: first?.[1] ?? null, levelEnd: last?.[1] ?? null,
    xpPerHour: online >= 10 * 60_000 ? Math.round(xp / online * 3_600_000) : null,
    goldPerHour: online >= 10 * 60_000 && first ? Math.round((last[4] - first[4]) / online * 3_600_000) : null,
    deaths: count('death'), levels: count('level'), disconnects: count('disconnected'), series,
  };
}
// The same summary from hourly totals [hour, xp, gold, online ms, level]; each point closes its hour.
export function summarizeHourly(hours, entries, from, to) {
  const inside = hours.filter(h => h[0] >= from && h[0] < to);
  let xp = 0, gold = 0, online = 0;
  const series = inside.map((h, i) => {
    xp += h[1]; gold += h[2]; online += h[3];
    return { t: h[0] + HOUR, xp, gold, level: h[4], gap: !i || h[0] - inside[i - 1][0] > HOUR };
  });
  const count = type => entries.filter(e => e.type === type && e.at >= from && e.at <= to).length;
  return {
    from, to, samples: inside.length, onlineMs: online, xpGained: xp, goldChange: gold,
    levelStart: inside[0]?.[4] ?? null, levelEnd: inside.at(-1)?.[4] ?? null,
    xpPerHour: online >= 10 * 60_000 ? Math.round(xp / online * 3_600_000) : null,
    goldPerHour: online >= 10 * 60_000 ? Math.round(gold / online * 3_600_000) : null,
    deaths: count('death'), levels: count('level'), disconnects: count('disconnected'), series,
  };
}
// Keeps at most `limit` points, always including the first and last one and every gap boundary.
export function downsample(series, limit) {
  if (series.length <= limit) return series;
  const step = series.length / limit, out = [];
  for (let i = 0; i < series.length; i++) {
    const point = series[i];
    if (i === 0 || i === series.length - 1 || point.gap || series[i + 1]?.gap || Math.floor(i / step) !== Math.floor((i - 1) / step)) out.push(point);
  }
  return out;
}
// XP and gold gained in each bucket (an hour or a day), for the bar charts.
export function buckets(points, from, to, size) {
  const count = Math.max(1, Math.ceil((to - from) / size));
  const out = Array.from({ length: count }, (_, i) => ({ t: from + i * size, xp: 0, gold: 0, onlineMs: 0 }));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b[0] < from || b[0] > to || b[0] - a[0] > SAMPLE_GAP) continue;
    const bucket = out[Math.min(count - 1, Math.floor((b[0] - from) / size))];
    bucket.xp += xpBetween(a, b); bucket.gold += b[4] - a[4]; bucket.onlineMs += b[0] - a[0];
  }
  return out;
}
export function hourlyBuckets(hours, from, to, size) {
  const count = Math.max(1, Math.ceil((to - from) / size));
  const out = Array.from({ length: count }, (_, i) => ({ t: from + i * size, xp: 0, gold: 0, onlineMs: 0 }));
  for (const [hour, xp, gold, online] of hours) {
    if (hour < from || hour >= to) continue;
    const bucket = out[Math.min(count - 1, Math.floor((hour - from) / size))];
    bucket.xp += xp; bucket.gold += gold; bucket.onlineMs += online;
  }
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, character_id TEXT, name TEXT, message TEXT NOT NULL, realm TEXT);
CREATE INDEX IF NOT EXISTS journal_at ON journal(at);
CREATE INDEX IF NOT EXISTS journal_character ON journal(character_id, id);
CREATE INDEX IF NOT EXISTS journal_type ON journal(type, id);
CREATE INDEX IF NOT EXISTS journal_type_character ON journal(type, character_id, at);
CREATE TABLE IF NOT EXISTS characters(id TEXT PRIMARY KEY, name TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS samples(character_id TEXT NOT NULL, at INTEGER NOT NULL, level INTEGER NOT NULL, xp INTEGER NOT NULL, max_xp INTEGER NOT NULL, gold INTEGER NOT NULL, PRIMARY KEY(character_id, at)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
CREATE TABLE IF NOT EXISTS hourly(character_id TEXT NOT NULL, hour INTEGER NOT NULL, xp INTEGER NOT NULL, gold INTEGER NOT NULL, online_ms INTEGER NOT NULL, level INTEGER NOT NULL, PRIMARY KEY(character_id, hour)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, character_id TEXT, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS logs_at ON logs(at);
CREATE INDEX IF NOT EXISTS logs_character ON logs(character_id, id);
`;

export class History extends EventEmitter {
  // dir null keeps everything in memory (tests and a panel without a data volume).
  constructor(dir = null, log = () => {}, now = Date.now) {
    super();
    this.dir = dir;
    this.file = dir ? path.join(dir, 'history.db') : ':memory:';
    this.legacy = dir ? path.join(dir, 'history.json') : null;
    this.log = log; this.now = now;
    this.db = null; this.statements = null; this.last = new Map(); this.seen = null; this.timer = null; this.closed = false;
  }
  async init() {
    this.open();
    await this.migrate();
    this.prune();
    this.timer = setInterval(() => { try { this.prune(); } catch (error) { this.log(`Údržba historie selhala: ${error.message}`); } }, PRUNE_EVERY);
    this.timer.unref?.();
  }
  open() {
    try { this.connect(); }
    catch (error) {
      if (!this.dir) throw error;
      // History is not essential: a damaged database is set aside and the panel starts with an empty one.
      try { this.db?.close(); } catch { /* Already closed. */ }
      const stamp = Date.now();
      for (const suffix of ['', '-wal', '-shm']) { try { renameSync(`${this.file}${suffix}`, `${this.file}${suffix}.broken-${stamp}`); } catch { /* Missing. */ } }
      this.log('Databáze historie byla poškozená; byla přejmenována a historie začíná znovu.');
      this.connect();
    }
  }
  connect() {
    this.db = new DatabaseSync(this.file);
    if (this.file !== ':memory:') {
      const check = this.db.prepare('PRAGMA quick_check').get();
      if (Object.values(check)[0] !== 'ok') throw new Error('quick_check');
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
    this.db.exec(SCHEMA);
    const db = this.db;
    this.statements = {
      journal: db.prepare('INSERT INTO journal(id, at, type, character_id, name, message, realm) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      character: db.prepare('INSERT INTO characters(id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name'),
      sample: db.prepare('INSERT OR REPLACE INTO samples(character_id, at, level, xp, max_xp, gold) VALUES (?, ?, ?, ?, ?, ?)'),
      lastSample: db.prepare('SELECT at, level, xp, max_xp, gold FROM samples WHERE character_id = ? ORDER BY at DESC LIMIT 1'),
      hourly: db.prepare(`INSERT INTO hourly(character_id, hour, xp, gold, online_ms, level) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(character_id, hour) DO UPDATE SET xp = xp + excluded.xp, gold = gold + excluded.gold, online_ms = online_ms + excluded.online_ms, level = excluded.level`),
      log: db.prepare('INSERT INTO logs(at, character_id, level, message) VALUES (?, ?, ?, ?)'),
    };
    this.last.clear();
  }
  // Imports the former history.json once; its samples also fill the hourly totals.
  async migrate() {
    if (!this.legacy) return;
    let raw;
    try { raw = JSON.parse(await readFile(this.legacy, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      await rename(this.legacy, `${this.legacy}.broken-${Date.now()}`).catch(() => {});
      this.log('Starý soubor historie byl poškozený; byl přejmenován a nepřevádí se.');
      return;
    }
    const entries = (Array.isArray(raw?.journal) ? raw.journal : []).filter(validEntry).map(entryView);
    let points = 0;
    this.transaction(() => {
      for (const e of entries) this.statements.journal.run(null, e.at, e.type, e.characterId, e.name, e.message, e.realm);
      for (const [id, value] of Object.entries(raw?.samples && typeof raw.samples === 'object' ? raw.samples : {})) {
        if (!ID.test(id) || !Array.isArray(value?.points)) continue;
        const name = typeof value.name === 'string' ? value.name.slice(0, 32) : '?';
        for (const p of value.points.filter(p => Array.isArray(p) && p.length === 5 && p.every(Number.isFinite)).sort((a, b) => a[0] - b[0])) {
          this.addSample(id, name, p.map(int)); points++;
        }
      }
    });
    await rename(this.legacy, `${this.legacy}.migrated`);
    this.log(`Historie převedena do databáze: ${entries.length} záznamů deníku a ${points} vzorků. Původní soubor je uložen jako history.json.migrated.`);
  }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  prune() {
    if (!this.db) return;
    const now = this.now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM journal WHERE at <= ?').run(now - JOURNAL_DAYS * DAY);
      this.db.prepare('DELETE FROM journal WHERE id <= (SELECT id FROM journal ORDER BY id DESC LIMIT 1 OFFSET ?)').run(JOURNAL_LIMIT);
      this.db.prepare('DELETE FROM samples WHERE at <= ?').run(now - SAMPLE_DAYS * DAY);
      this.db.prepare('DELETE FROM hourly WHERE hour <= ?').run(now - HOURLY_DAYS * DAY);
      this.db.prepare('DELETE FROM logs WHERE at <= ?').run(now - LOG_DAYS * DAY);
      this.db.prepare('DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?)').run(LOG_STORED);
      this.db.prepare('DELETE FROM characters WHERE id NOT IN (SELECT character_id FROM hourly) AND id NOT IN (SELECT character_id FROM samples)').run();
    });
    this.last.clear(); this.seen = null;
  }
  record({ type, characterId = null, name = null, message, realm = null }) {
    if (!JOURNAL_TYPES.includes(type) || this.closed || !this.db) return null;
    const entry = entryView({ id: 0, at: this.now(), type, characterId, name, message: String(message), realm });
    entry.id = Number(this.statements.journal.run(null, entry.at, entry.type, entry.characterId, entry.name, entry.message, entry.realm).lastInsertRowid);
    if (this.seen && entry.characterId && SEEN_TYPES.includes(entry.type)) this.seen.set(entry.characterId, entry.at);
    this.emit('entry', entry);
    return entry;
  }
  // A game or CODE log line; the panel keeps the newest ones in memory, the database a week of them.
  addLog({ at, characterId = null, level, message }) {
    if (this.closed || !this.db) return;
    const time = typeof at === 'string' ? Date.parse(at) : at;
    this.statements.log.run(Number.isFinite(time) ? time : this.now(), typeof characterId === 'string' && ID.test(characterId) ? characterId : null, level === 'error' ? 'error' : 'info', String(message).slice(0, 4000));
  }
  // Stores one sample [time, level, xp, max xp, gold] and adds what changed since the previous one to its hour.
  addSample(id, name, point) {
    const previous = this.last.get(id) ?? this.lastPoint(id);
    if (previous && point[0] <= previous[0]) return;
    this.statements.character.run(id, String(name).slice(0, 32));
    this.statements.sample.run(id, ...point);
    const hour = Math.floor(point[0] / HOUR) * HOUR;
    if (previous && point[0] - previous[0] <= SAMPLE_GAP) this.statements.hourly.run(id, hour, xpBetween(previous, point), point[4] - previous[4], point[0] - previous[0], point[1]);
    else this.statements.hourly.run(id, hour, 0, 0, 0, point[1]);
    this.last.set(id, point);
  }
  lastPoint(id) {
    const row = this.statements.lastSample.get(id);
    return row ? [row.at, row.level, row.xp, row.max_xp, row.gold] : null;
  }
  // One sample every five minutes per character: [time, level, xp, max xp, gold].
  sample(id, name, state) {
    if (!ID.test(id) || !state || this.closed || !this.db) return false;
    const now = this.now(), last = this.last.get(id) ?? this.lastPoint(id);
    if (last && now - last[0] < SAMPLE_EVERY) return false;
    this.addSample(id, name, [now, int(state.level), int(state.xp), int(state.max_xp), int(state.gold)]);
    return true;
  }
  // When each character was last seen running: its last sample or its last start, connection or stop.
  // The dashboard asks every few seconds, so the journal part is read once and then kept up to date by record().
  lastSeen() {
    const seen = {};
    for (const row of this.db.prepare('SELECT character_id, MAX(at) AS at FROM samples GROUP BY character_id').all()) seen[row.character_id] = row.at;
    this.seen ??= new Map(this.db.prepare(`SELECT character_id, MAX(at) AS at FROM journal WHERE character_id IS NOT NULL AND type IN (${SEEN_TYPES.map(() => '?').join(', ')}) GROUP BY character_id`).all(...SEEN_TYPES).map(r => [r.character_id, r.at]));
    for (const [id, at] of this.seen) if (!(seen[id] >= at)) seen[id] = at;
    return seen;
  }
  // Newest first. after returns entries newer than an id (for polling); before pages back from an id;
  // page counts pages of `limit` entries from the newest one (or from `until`, a time to jump back to).
  query({ types = null, characterId = null, realm = null, before = null, after = null, until = null, page = 1, limit = 100 } = {}) {
    const where = [], params = [];
    if (types?.length) { where.push(`type IN (${types.map(() => '?').join(', ')})`); params.push(...types); }
    if (characterId) { where.push('character_id = ?'); params.push(characterId); }
    if (realm) { where.push('realm = ?'); params.push(realm); }
    if (until !== null) { where.push('at <= ?'); params.push(until); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM journal ${filter}`).get(...params).n;
    const cursor = [...where], cursorParams = [...params];
    if (before !== null) { cursor.push('id < ?'); cursorParams.push(before); }
    if (after !== null) { cursor.push('id > ?'); cursorParams.push(after); }
    const offset = before === null && after === null ? (Math.max(1, page) - 1) * limit : 0;
    const rows = this.db.prepare(`SELECT * FROM journal ${cursor.length ? `WHERE ${cursor.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...cursorParams, limit + 1, offset);
    return { entries: rows.slice(0, limit).map(journalRow), more: rows.length > limit, total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / limit)) };
  }
  // Stored logs, newest first, filtered by character ('system' for the panel's own), errors and text.
  logs({ characterId = null, errors = false, text = '', until = null, page = 1, limit = 100 } = {}) {
    const where = [], params = [];
    if (characterId === 'system') where.push('character_id IS NULL');
    else if (characterId) { where.push('character_id = ?'); params.push(characterId); }
    if (errors) where.push(`level = 'error'`);
    if (text) { where.push(`message LIKE ? ESCAPE '\\'`); params.push(like(text)); }
    if (until !== null) { where.push('at <= ?'); params.push(until); }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM logs ${filter}`).get(...params).n;
    const rows = this.db.prepare(`SELECT * FROM logs ${filter} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, (Math.max(1, page) - 1) * limit);
    return { entries: rows.map(logRow), total, page: Math.max(1, page), pages: Math.max(1, Math.ceil(total / limit)) };
  }
  // Long-term stats of every character with samples between from and to, bucketed by bucketMs.
  // Up to two weeks come from the five-minute samples, longer ranges from the hourly totals.
  stats(from, to, bucketMs, limit = 240) {
    const names = new Map(this.db.prepare('SELECT id, name FROM characters').all().map(r => [r.id, r.name]));
    // Deaths, level-ups and disconnects are counted in the database rather than read entry by entry.
    const counts = new Map();
    for (const r of this.db.prepare(`SELECT character_id, type, COUNT(*) AS n FROM journal WHERE type IN ('death', 'level', 'disconnected') AND character_id IS NOT NULL AND at BETWEEN ? AND ? GROUP BY character_id, type`).all(from, to)) {
      if (!counts.has(r.character_id)) counts.set(r.character_id, { death: 0, level: 0, disconnected: 0 });
      counts.get(r.character_id)[r.type] = r.n;
    }
    const detailed = to - from <= DETAIL_SPAN, grouped = new Map();
    const rows = detailed
      ? this.db.prepare('SELECT character_id AS id, at, level, xp, max_xp, gold FROM samples WHERE at BETWEEN ? AND ? ORDER BY character_id, at').all(from - SAMPLE_GAP, to)
      : this.db.prepare('SELECT character_id AS id, hour, xp, gold, online_ms, level FROM hourly WHERE hour >= ? AND hour < ? ORDER BY character_id, hour').all(from, to);
    for (const r of rows) {
      if (!grouped.has(r.id)) grouped.set(r.id, []);
      grouped.get(r.id).push(detailed ? [r.at, r.level, r.xp, r.max_xp, r.gold] : [r.hour, r.xp, r.gold, r.online_ms, r.level]);
    }
    return [...grouped].map(([id, points]) => {
      const summary = detailed ? summarizeHistory(points, [], from, to) : summarizeHourly(points, [], from, to);
      const count = counts.get(id) || { death: 0, level: 0, disconnected: 0 };
      return {
        id, name: names.get(id) || '?', ...summary, deaths: count.death, levels: count.level, disconnects: count.disconnected,
        series: downsample(summary.series, limit), buckets: detailed ? buckets(points, from, to, bucketMs) : hourlyBuckets(points, from, to, bucketMs),
      };
    }).filter(c => c.samples > 0).sort((a, b) => a.name.localeCompare(b.name));
  }
  // Size of the database and what it holds, for the System page.
  usage() {
    const count = table => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const pages = this.db.prepare('PRAGMA page_count').get().page_count, size = this.db.prepare('PRAGMA page_size').get().page_size;
    return { bytes: pages * size, journal: count('journal'), samples: count('samples'), hourly: count('hourly'), logs: count('logs') };
  }
  // Writes go straight to the database; kept for callers that wait for history to be stored.
  flush() { return Promise.resolve(); }
  async close() {
    clearInterval(this.timer); this.timer = null;
    if (this.closed) return;
    this.closed = true;
    try { if (this.file !== ':memory:') this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* The WAL is replayed on the next start. */ }
    this.db?.close();
  }
}
