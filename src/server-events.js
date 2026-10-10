// Server-wide events and bosses (the game client's S object, sent by the game server to every connected client).
const KEY = /^[a-z0-9_]{1,32}$/;
const NAME = /^[a-zA-Z0-9_]{1,32}$/;
// Bosses and events the game client itself shows in its server bar (html.js render_server).
export const BOSSES = ['franky', 'icegolem', 'crabxx', 'wabbit', 'mrpumpkin', 'mrgreen', 'snowman', 'dragold', 'grinch', 'pinkgoo', 'slenderman', 'tiger'];
export const EVENTS = ['goobrawl', 'abtesting', 'halloween', 'holidayseason', 'lunarnewyear', 'egghunt', 'valentines', 'anniversary'];
// Keys of S that are settings, not events.
const IGNORED = new Set(['schedule', 'minutes']);
const finite = value => Number.isFinite(value) ? Math.round(value) : null;
const time = value => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.length <= 40 ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const title = value => typeof value === 'string' && value.length > 0 && value.length <= 60 ? value : null;

// The game page is not trusted: only known fields of each entry leave the server.
export function serverEventsView(raw) {
  const source = raw?.S && typeof raw.S === 'object' ? raw.S : {};
  const titles = raw?.titles && typeof raw.titles === 'object' ? raw.titles : {};
  const events = [];
  for (const [key, value] of Object.entries(source).slice(0, 80)) {
    if (!KEY.test(key) || IGNORED.has(key) || !value) continue;
    if (value !== true && typeof value !== 'object') continue;
    const object = typeof value === 'object' ? value : {};
    // Seasonal events are plain flags or objects without a live state; anniversary reports active separately.
    if (object.active === false) continue;
    const boss = BOSSES.includes(key) || 'live' in object || 'spawn' in object;
    events.push({
      key, title: title(titles[key]) || key, kind: boss ? 'boss' : value === true || !('end' in object) ? 'seasonal' : 'event',
      live: typeof object.live === 'boolean' ? object.live : null, spawn: time(object.spawn), end: time(object.end),
      hp: finite(object.hp), maxHp: finite(object.max_hp), map: typeof object.map === 'string' && KEY.test(object.map) ? object.map : null,
      x: finite(object.x), y: finite(object.y), target: typeof object.target === 'string' && NAME.test(object.target) ? object.target : null,
    });
  }
  const order = { boss: 0, event: 1, seasonal: 2 };
  events.sort((a, b) => (b.live === true) - (a.live === true) || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));
  const schedule = source.schedule && typeof source.schedule === 'object' ? source.schedule : null;
  const hours = list => Array.isArray(list) ? list.filter(h => Number.isInteger(h) && h >= 0 && h < 24).slice(0, 24) : [];
  return {
    events,
    schedule: schedule ? { timeOffset: Number.isInteger(schedule.time_offset) && Math.abs(schedule.time_offset) <= 24 ? schedule.time_offset : 0, dailies: hours(schedule.dailies), nightlies: hours(schedule.nightlies), night: !!schedule.night } : null,
  };
}

// A boss appearing, a boss leaving and an event starting or ending, comparing two readings of one server.
export function eventTransitions(previous, next) {
  const before = new Map((previous?.events || []).map(e => [e.key, e]));
  const after = new Map((next?.events || []).map(e => [e.key, e]));
  const changes = [];
  const active = e => e && e.live !== false;
  for (const [key, event] of after) {
    if (active(event) && !active(before.get(key))) changes.push({ key, title: event.title, change: 'start', event });
  }
  for (const [key, event] of before) {
    if (active(event) && !active(after.get(key))) changes.push({ key, title: event.title, change: 'end', event });
  }
  return changes;
}
