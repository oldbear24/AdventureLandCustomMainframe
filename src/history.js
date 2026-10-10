// Persistent history in the data volume: a journal of notable events and long-term XP/gold samples.
// Both survive restarts, unlike the in-memory logs and the one-hour stats of each character card.
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const JOURNAL_TYPES = ['start', 'connected', 'disconnected', 'stop', 'death', 'level', 'code', 'code_error', 'alert', 'move', 'event'];
export const JOURNAL_LIMIT = 5000;
export const JOURNAL_DAYS = 30;
export const SAMPLE_EVERY = 5 * 60_000;
export const SAMPLE_DAYS = 14;
// A longer pause between two samples means the character was not running in between.
export const SAMPLE_GAP = 3 * SAMPLE_EVERY;
const DAY = 86_400_000;
const SAVE_DELAY = 30_000;
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

// XP gained across level-ups, gold change, levels, deaths and time online over [from, to].
export function summarizeHistory(points, entries, from, to) {
  const inside = points.filter(p => p[0] >= from && p[0] <= to);
  let xp = 0, online = 0;
  const series = [];
  for (let i = 0; i < inside.length; i++) {
    const [t, level, value, , gold] = inside[i], previous = inside[i - 1];
    if (previous && t - previous[0] <= SAMPLE_GAP) {
      online += t - previous[0];
      if (level === previous[1]) xp += Math.max(0, value - previous[2]);
      else if (level > previous[1]) xp += Math.max(0, (previous[3] || previous[2]) - previous[2]) + value;
    }
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
    if (b[1] === a[1]) bucket.xp += Math.max(0, b[2] - a[2]);
    else if (b[1] > a[1]) bucket.xp += Math.max(0, (a[3] || a[2]) - a[2]) + b[2];
    bucket.gold += b[4] - a[4]; bucket.onlineMs += b[0] - a[0];
  }
  return out;
}

export class History extends EventEmitter {
  constructor(dir = null, log = () => {}, now = Date.now) {
    super();
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.log = log; this.now = now;
    this.journal = []; this.samples = new Map(); this.nextId = 1;
    this.timer = null; this.saving = Promise.resolve(); this.closed = false;
  }
  async init() {
    if (!this.file) return;
    let raw;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      // History is not essential: a damaged file is set aside and the panel starts with an empty one.
      await rename(this.file, `${this.file}.broken-${Date.now()}`).catch(() => {});
      this.log('Soubor historie byl poškozený; byl přejmenován a historie začíná znovu.');
      return;
    }
    this.journal = (Array.isArray(raw?.journal) ? raw.journal : []).filter(validEntry).map(entryView);
    this.nextId = Math.max(1, ...this.journal.map(e => e.id + 1));
    for (const [id, value] of Object.entries(raw?.samples && typeof raw.samples === 'object' ? raw.samples : {})) {
      if (!ID.test(id) || !Array.isArray(value?.points)) continue;
      const points = value.points.filter(p => Array.isArray(p) && p.length === 5 && p.every(Number.isFinite));
      this.samples.set(id, { name: typeof value.name === 'string' ? value.name.slice(0, 32) : '?', points });
    }
    this.prune();
  }
  prune() {
    const now = this.now();
    this.journal = this.journal.filter(e => now - e.at < JOURNAL_DAYS * DAY).slice(-JOURNAL_LIMIT);
    for (const [id, entry] of this.samples) {
      entry.points = entry.points.filter(p => now - p[0] < SAMPLE_DAYS * DAY);
      if (!entry.points.length) this.samples.delete(id);
    }
  }
  record({ type, characterId = null, name = null, message, realm = null }) {
    if (!JOURNAL_TYPES.includes(type) || this.closed) return null;
    const entry = entryView({ id: this.nextId++, at: this.now(), type, characterId, name, message: String(message), realm });
    this.journal.push(entry);
    if (this.journal.length > JOURNAL_LIMIT) this.journal.shift();
    this.scheduleSave(); this.emit('entry', entry);
    return entry;
  }
  // One sample every five minutes per character: [time, level, xp, max xp, gold].
  sample(id, name, state) {
    if (!ID.test(id) || !state || this.closed) return false;
    const now = this.now(), entry = this.samples.get(id) || { name, points: [] };
    const last = entry.points.at(-1);
    if (last && now - last[0] < SAMPLE_EVERY) return false;
    entry.name = String(name).slice(0, 32);
    entry.points.push([now, int(state.level), int(state.xp), int(state.max_xp), int(state.gold)]);
    while (entry.points.length && now - entry.points[0][0] >= SAMPLE_DAYS * DAY) entry.points.shift();
    this.samples.set(id, entry); this.scheduleSave();
    return true;
  }
  // Newest first. after returns entries newer than an id (for polling); before pages back.
  query({ types = null, characterId = null, realm = null, before = null, after = null, limit = 100 } = {}) {
    const matches = e => (!types || types.includes(e.type)) && (!characterId || e.characterId === characterId) && (!realm || e.realm === realm) &&
      (before === null || e.id < before) && (after === null || e.id > after);
    const out = [];
    for (let i = this.journal.length - 1; i >= 0 && out.length <= limit; i--) if (matches(this.journal[i])) out.push(this.journal[i]);
    return { entries: out.slice(0, limit), more: out.length > limit };
  }
  // Long-term stats of every character with samples between from and to, bucketed by bucketMs.
  stats(from, to, bucketMs, limit = 240) {
    return [...this.samples].map(([id, { name, points }]) => {
      const entries = this.journal.filter(e => e.characterId === id);
      const summary = summarizeHistory(points, entries, from, to);
      return { id, name, ...summary, series: downsample(summary.series, limit), buckets: buckets(points, from, to, bucketMs) };
    }).filter(c => c.samples > 0).sort((a, b) => a.name.localeCompare(b.name));
  }
  scheduleSave() {
    if (!this.file || this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(error => this.log(`Uložení historie selhalo: ${error.message}`)); }, SAVE_DELAY);
    this.timer.unref?.();
  }
  flush() {
    if (!this.file) return Promise.resolve();
    this.saving = this.saving.catch(() => {}).then(async () => {
      this.prune();
      const body = JSON.stringify({ version: 1, journal: this.journal, samples: Object.fromEntries(this.samples) });
      const temporary = path.join(path.dirname(this.file), `history-${randomUUID()}.tmp`);
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.saving;
  }
  async close() {
    clearTimeout(this.timer); this.timer = null;
    await this.flush(); this.closed = true;
  }
}
