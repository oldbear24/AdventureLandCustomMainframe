// Pure helpers for character telemetry: sanitizing extra live fields, XP/gold history, activity and alerts.
const KEY = /^[a-zA-Z0-9_]{1,40}$/;
const NAME = /^[a-zA-Z0-9_]{1,32}$/;
const KINDS = new Set(['buff', 'debuff', 'neutral']);
const num = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
const label = (value, max = 60) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
export const SAMPLE_INTERVAL = 60_000;
export const STATS_WINDOW = 60 * 60_000;
export const NOTIFY_COOLDOWN = 15 * 60_000;

// The game page is not trusted: only whitelisted fields of conditions, skills and party leave the server.
export function conditionsView(list) {
  return (Array.isArray(list) ? list : []).filter(c => KEY.test(c?.key)).slice(0, 30).map(c => ({
    key: c.key, name: label(c.name) || c.key, kind: KINDS.has(c.kind) ? c.kind : 'neutral', ms: num(c.ms),
  }));
}
export function skillsView(list) {
  return (Array.isArray(list) ? list : []).filter(s => KEY.test(s?.key)).slice(0, 30).map(s => ({
    key: s.key, name: label(s.name) || s.key, ms: Math.max(0, num(s.ms) ?? 0), cooldown: num(s.cooldown),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
export function partyView(raw) {
  if (!raw || !NAME.test(raw.leader)) return null;
  const members = (Array.isArray(raw.members) ? raw.members : []).filter(m => NAME.test(m?.name)).slice(0, 10).map(m => ({
    name: m.name, ctype: label(m.ctype, 24), level: num(m.level), map: typeof m.map === 'string' && KEY.test(m.map) ? m.map : null, x: num(m.x), y: num(m.y),
  }));
  return { leader: raw.leader, members };
}
export function extrasView(raw) {
  const potions = raw?.potions || {};
  return {
    max_xp: num(raw?.max_xp), esize: num(raw?.esize), isize: num(raw?.isize),
    potions: { hp: Math.max(0, num(potions.hp) ?? 0), mp: Math.max(0, num(potions.mp) ?? 0) },
    conditions: conditionsView(raw?.conditions), skills: skillsView(raw?.skills), party: partyView(raw?.party),
    lastSkillAt: num(raw?.lastSkillAt),
  };
}

// One sample a minute, at most an hour (plus one) kept.
export function addSample(samples, state, now) {
  const last = samples.at(-1);
  if (!state || (last && now - last.t < SAMPLE_INTERVAL)) return samples;
  samples.push({ t: now, level: num(state.level) ?? 0, xp: num(state.xp) ?? 0, maxXp: num(state.max_xp), gold: num(state.gold) ?? 0 });
  while (samples.length > 2 && now - samples[1].t >= STATS_WINDOW) samples.shift();
  return samples;
}
// XP gained across level-ups and net gold change over the window, with per-hour rates and level ETA.
export function summarizeStats(samples, state, now) {
  const points = [...samples];
  if (state) points.push({ t: now, level: num(state.level) ?? 0, xp: num(state.xp) ?? 0, maxXp: num(state.max_xp), gold: num(state.gold) ?? 0 });
  if (!points.length) return null;
  const first = points[0];
  let xp = 0;
  const series = [{ t: first.t, xp: 0, gold: 0 }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (b.level === a.level) xp += Math.max(0, b.xp - a.xp);
    else if (b.level > a.level) xp += Math.max(0, (a.maxXp ?? a.xp) - a.xp) + b.xp;
    if (i < points.length - 1 || now - a.t >= 5_000) series.push({ t: b.t, xp, gold: b.gold - first.gold });
  }
  const windowMs = now - first.t;
  const rated = windowMs >= 2 * 60_000;
  const xpPerHour = rated ? Math.round(xp / windowMs * 3_600_000) : null;
  const goldPerHour = rated ? Math.round((points.at(-1).gold - first.gold) / windowMs * 3_600_000) : null;
  const remaining = state && num(state.max_xp) ? Math.max(0, state.max_xp - state.xp) : null;
  const etaMs = remaining !== null && xpPerHour > 0 ? Math.round(remaining / xpPerHour * 3_600_000) : null;
  return { windowMs, xpGained: xp, goldChange: points.at(-1).gold - first.gold, xpPerHour, goldPerHour, etaMs, series: series.slice(-61) };
}

// Movement, XP, gold, level, a target change or a used skill all count as activity.
export function isActivity(previous, next) {
  if (!previous || !next) return true;
  return Math.hypot((next.x ?? 0) - (previous.x ?? 0), (next.y ?? 0) - (previous.y ?? 0)) >= 2 || next.xp !== previous.xp || next.gold !== previous.gold ||
    next.level !== previous.level || next.target !== previous.target || next.map !== previous.map || (next.lastSkillAt ?? 0) > (previous.lastSkillAt ?? 0);
}

export function alertsFor(session, character, now) {
  const alerts = [], state = session.state;
  const minutes = ms => Math.floor(ms / 60_000);
  if (session.status === 'reconnecting' && session.attempts >= 2) {
    alerts.push({ type: 'reconnect', message: `Opakovaně padá do reconnectu (${session.attempts}× za sebou)${session.error ? `: ${session.error}` : '.'}` });
  }
  if (session.status === 'running' && state) {
    if (state.rip) alerts.push({ type: 'dead', message: 'Postava je mrtvá.' });
    const idleMinutes = character?.idleMinutes ?? 10;
    const idle = now - (session.lastActivityAt ?? now);
    if (!state.rip && idleMinutes > 0 && idle >= idleMinutes * 60_000) alerts.push({ type: 'idle', message: `Nic nedělá ${minutes(idle)} min: žádný pohyb, útok ani XP.` });
    const potionMin = character?.potionMin ?? 10;
    const potions = state.potions;
    if (potionMin > 0 && potions && (potions.hp < potionMin || potions.mp < potionMin)) alerts.push({ type: 'potions', message: `Docházejí lektvary: HP ${potions.hp}, MP ${potions.mp} (limit ${potionMin}).` });
  }
  if (session.code?.error) alerts.push({ type: 'code', message: 'CODE je pozastaven kvůli chybě synchronizace.' });
  return alerts;
}
