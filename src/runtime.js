import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { NOTIFY_COOLDOWN, addSample, alertsFor, extrasView, isActivity, summarizeStats } from './telemetry.js';
import { EventEmitter } from 'node:events';
import { eventTransitions, serverEventsView } from './server-events.js';

export const GAME_ORIGIN = 'https://adventure.land';
export const LOG_LIMIT = 200;
// How often the game page pushes a changed position to the panel.
export const LIVE_INTERVAL = 250;
// How often an open stand that has not moved is saved again.
export const STAND_REFRESH = 10 * 60_000;
export async function withDeadline(operation, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Herní klient nereaguje v časovém limitu.')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export function characterUrl(character) {
  const url = new URL(`/character/${encodeURIComponent(character.name)}/in/${encodeURIComponent(character.region)}/${encodeURIComponent(character.server)}/`, GAME_ORIGIN);
  url.searchParams.set('no_graphics', 'true');
  url.searchParams.set('no_html', 'true');
  url.searchParams.set('is_bot', '1');
  return url.href;
}

// Game pages report state as JSON; keep only bounded, typed fields.
export function sanitizeState(raw) {
  let state = raw;
  if (typeof state === 'string') {
    if (state.length > 64_000) return null;
    try { state = JSON.parse(state); } catch { return null; }
  }
  if (!state || typeof state !== 'object') return null;
  const num = value => Number.isFinite(value) ? value : 0;
  const str = (value, max = 40) => typeof value === 'string' ? value.slice(0, max) : '';
  const nearby = (Array.isArray(state.nearby) ? state.nearby.slice(0, 60) : []).filter(e => e && Number.isFinite(e.x) && Number.isFinite(e.y))
    .map(e => ({ id: str(e.id), kind: e.kind === 'monster' ? 'monster' : 'character', name: str(e.name), x: Math.round(e.x), y: Math.round(e.y), target: !!e.target, stand: e.kind !== 'monster' && !!e.stand }));
  // When the game page sampled the state (server clock); a missing or implausible time falls back to now.
  const at = Number.isFinite(state.at) && Math.abs(state.at - Date.now()) < 60_000 ? Math.round(state.at) : Date.now();
  return {
    name: str(state.name, 32), ctype: str(state.ctype, 20), level: num(state.level), hp: num(state.hp), max_hp: num(state.max_hp), mp: num(state.mp), max_mp: num(state.max_mp),
    gold: num(state.gold), xp: num(state.xp), map: str(state.map), x: num(state.x), y: num(state.y), rip: !!state.rip, ping: num(state.ping), stand: !!state.stand,
    codeRunning: !!state.codeRunning, nearby, target: typeof state.target === 'string' ? state.target.slice(0, 40) : null, at, observedAt: new Date().toISOString(),
  };
}

// CODE set(name, value) stores JSON in the page's localStorage under "cstore_" + name.
export const STORAGE_PREFIX = 'cstore_';
export const STORAGE_LIMIT = 500;
export const STORAGE_VALUE_LIMIT = 64_000;
export const STORAGE_KEY_LIMIT = 200;
const REDACTED = '[REDACTED]';
export function storageView(raw) {
  const entries = (Array.isArray(raw) ? raw : []).filter(e => e && typeof e.key === 'string' && typeof e.value === 'string');
  const view = entries.slice(0, STORAGE_LIMIT).map(({ key, value }) => {
    let text = value, valid = true;
    try { text = JSON.stringify(JSON.parse(value), null, 2) ?? value; } catch { valid = false; }
    const truncated = text.length > STORAGE_VALUE_LIMIT;
    // A shortened or redacted key cannot address the stored value; a shortened or redacted value cannot be saved back intact.
    const deletable = key.length > 0 && key.length <= STORAGE_KEY_LIMIT && !key.includes(REDACTED);
    return { key: key.slice(0, STORAGE_KEY_LIMIT), size: value.length, valid, value: text.slice(0, STORAGE_VALUE_LIMIT), truncated, deletable, editable: deletable && !truncated && !value.includes(REDACTED) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { entries: view, total: entries.length, size: entries.reduce((sum, e) => sum + e.key.length + e.value.length, 0), observedAt: new Date().toISOString() };
}

// Runs inside the game page. Collects what the character's CODE lets the panel set and what it reports doing,
// then lists it ('list'), sets one value ('set'), applies remembered values ('apply') or runs a chat command ('command').
// Sources: window.mainframe_controls / window.mainframe_activity defined by CODE (README, Automatizace), plus the
// globals adventure_primary (team farming target) and adventure_team (module switches, plan, events) when present.
export async function pageControls(input) {
  const runner = window.document?.getElementById('maincode')?.contentWindow;
  if (!window.code_active || !runner) return { running: false, controls: [], commands: false, activity: null, errors: [] };
  const KEY = /^[a-zA-Z0-9_.:-]{1,80}$/, TYPES = ['boolean', 'number', 'text', 'select', 'item', 'monster', 'target'];
  const MODULES = { learning: 'Učení lovišť', combat: 'Boj', skills: 'Podpůrné schopnosti', supply: 'Zásobování', equipment: 'Výbava', economy: 'Správa zlata', gathering: 'Sběr', storage: 'Svoz do banky' };
  const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
  const finite = value => Number.isFinite(value) ? value : null;
  const message = error => text(String(error?.message || error?.reason || error), 200);
  const errors = [], controls = [];
  const add = control => { if (!controls.some(c => c.key === control.key)) controls.push(control); };
  try {
    let own = runner.mainframe_controls;
    if (typeof own === 'function') own = own();
    for (const c of Array.isArray(own) ? own.slice(0, 50) : []) {
      if (!c || typeof c.key !== 'string' || !KEY.test(c.key) || typeof c.set !== 'function') continue;
      add({
        key: c.key, label: text(c.label, 80) || c.key, group: text(c.group, 60) || 'Nastavení CODE', type: TYPES.includes(c.type) ? c.type : 'text', help: text(c.help, 400),
        options: Array.isArray(c.options) ? c.options.filter(o => typeof o === 'string').slice(0, 50).map(o => o.slice(0, 80)) : null, min: finite(c.min), max: finite(c.max),
        get: () => typeof c.get === 'function' ? c.get() : c.value, status: () => typeof c.status === 'function' ? c.status() : c.status, set: value => c.set(value),
      });
    }
  } catch (error) { errors.push(`mainframe_controls: ${message(error)}`); }
  const primary = runner.adventure_primary;
  if (primary && typeof primary.set === 'function' && typeof primary.status === 'function') add({
    key: 'primary', label: 'Hlavní cíl farmení', group: 'Farmení celého týmu', type: 'target', options: null, min: null, max: null,
    help: 'Předmět nebo příšera pro celý tým. U předmětu lze zadat počet kusů – po jeho dosažení se cíl sám zruší (0 = až do zrušení). Bez cíle si tým vybírá loviště sám podle XP a zlata.',
    get: () => { const s = primary.status(); return { target: s?.target || '', goal: s?.goal || 0 }; },
    status: () => { const s = primary.status(); return { text: s?.status, by: s?.by, sources: s?.sources }; },
    set: value => value.target ? primary.set(value.target, value.goal) : primary.clear(),
  });
  const team = runner.adventure_team;
  let snapshot = null;
  if (team && typeof team.snapshot === 'function') { try { snapshot = team.snapshot(); } catch (error) { errors.push(`adventure_team: ${message(error)}`); } }
  const modules = snapshot?.autonomy?.modules;
  if (typeof team?.setModule === 'function' && modules && typeof modules === 'object') {
    for (const [name, row] of Object.entries(modules)) {
      if (!/^[a-zA-Z0-9_]{1,40}$/.test(name) || typeof row?.enabled !== 'boolean') continue;
      add({
        key: `module.${name}`, label: MODULES[name] || name, group: 'Moduly této postavy', type: 'boolean', help: '', options: null, min: null, max: null,
        get: () => row.enabled, fresh: () => team.snapshot().autonomy.modules[name].enabled,
        status: () => !row.enabled ? 'vypnuto' : row.until > Date.now() ? 'čeká po chybě' : row.busy ? 'pracuje' : 'zapnuto', set: value => team.setModule(name, value),
      });
    }
  }
  const expedition = snapshot?.expedition;
  if (typeof team?.setDungeons === 'function' && typeof expedition?.enabled === 'boolean') add({
    key: 'dungeons', label: 'Dungeonové výpravy', group: 'Farmení celého týmu', type: 'boolean', options: null, min: null, max: null,
    help: 'Pravidelné krátké výpravy celé skupiny do Cave of Darkness.', get: () => expedition.enabled, fresh: () => team.snapshot().expedition.enabled,
    status: () => expedition.state?.reason, set: value => team.setDungeons(value),
  });
  const safeValue = (type, value) => {
    if (type === 'boolean') return !!value;
    if (type === 'number') return finite(Number(value));
    if (type === 'target') return { target: text(value?.target, 40), goal: Number.isInteger(value?.goal) && value.goal >= 0 ? Math.min(value.goal, 9999) : 0 };
    return value === null || value === undefined ? '' : text(String(value), 200);
  };
  const statusOf = raw => {
    if (typeof raw === 'string') return { text: raw.slice(0, 600) };
    if (!raw || typeof raw !== 'object') return null;
    const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 8).filter(r => r && typeof r === 'object').map(r => ({ name: text(r.name, 60) || text(r.type, 60), chance: finite(r.chance), map: text(r.map, 40) })) : [];
    return { text: text(raw.text, 600), by: text(raw.by, 40), sources };
  };
  const view = c => {
    let value = null, status = null;
    try { value = safeValue(c.type, c.get()); } catch (error) { errors.push(`${c.key}: ${message(error)}`); }
    try { status = statusOf(c.status()); } catch { status = null; }
    return { key: c.key, label: c.label, group: c.group, type: c.type, help: c.help, options: c.options, min: c.min, max: c.max, value, status };
  };
  const invalid = (c, value) => {
    if (c.type === 'boolean') return typeof value === 'boolean' ? null : 'Očekávám zapnuto nebo vypnuto.';
    if (c.type === 'number') return !Number.isFinite(value) ? 'Očekávám číslo.' : c.min !== null && value < c.min ? `Nejméně ${c.min}.` : c.max !== null && value > c.max ? `Nejvýše ${c.max}.` : null;
    if (c.type === 'target') return value && typeof value === 'object' && typeof value.target === 'string' && value.target.length <= 40 && Number.isInteger(value.goal) && value.goal >= 0 && value.goal <= 9999 ? null : 'Očekávám cíl a počet kusů.';
    if (typeof value !== 'string' || value.length > 200) return 'Očekávám text do 200 znaků.';
    return c.type === 'select' && c.options && !c.options.includes(value) ? 'Hodnota není mezi nabízenými možnostmi.' : null;
  };
  const apply = async (key, value) => {
    const c = controls.find(x => x.key === key);
    if (!c) return { key, ok: false, missing: true, message: 'CODE toto nastavení teď nenabízí.' };
    const problem = invalid(c, value);
    if (problem) return { key, label: c.label, ok: false, message: problem };
    let result;
    try { result = await c.set(value); } catch (error) { return { key, label: c.label, ok: false, message: `CODE hodnotu nepřijal: ${message(error)}` }; }
    if (result === false) return { key, label: c.label, ok: false, message: 'CODE hodnotu odmítl; důvod najdeš v logu postavy.' };
    // Values read from adventure_team's snapshot were taken before the change, so they are read again.
    let current;
    try { current = (c.fresh || c.get)(); } catch { current = value; }
    return { key, label: c.label, ok: true, value: safeValue(c.type, current) };
  };
  if (input.action === 'set') return apply(input.key, input.value);
  if (input.action === 'apply') {
    const results = [];
    for (const [key, value] of input.values) results.push(await apply(key, value));
    return { running: true, results };
  }
  if (input.action === 'command') {
    if (typeof runner.handle_command !== 'function') return { ok: false, message: 'CODE nemá funkci handle_command.' };
    let result;
    try { result = await runner.handle_command(input.name, input.args); } catch (error) { return { ok: false, message: `Příkaz selhal: ${message(error)}` }; }
    return result === -1 ? { ok: false, message: `CODE příkaz /${input.name} nezná.` } : { ok: true };
  }
  let activity = null;
  try {
    const own = typeof runner.mainframe_activity === 'function' ? runner.mainframe_activity() : null;
    const plan = own || snapshot?.plan;
    const events = Array.isArray(own?.events) ? own.events : Array.isArray(snapshot?.events) ? snapshot.events : [];
    if (plan || events.length) {
      activity = {
        current: text(plan?.current), next: text(plan?.next), mode: text(plan?.mode, 20), leader: text(plan?.leader, 40),
        events: events.slice(-15).filter(e => e && typeof e.text === 'string').map(e => ({ at: finite(e.at), kind: text(e.kind, 30), text: text(e.text, 220), status: text(e.status, 20) })),
      };
    }
  } catch (error) { errors.push(`činnost: ${message(error)}`); }
  return { running: true, controls: controls.map(view), commands: typeof runner.handle_command === 'function', activity, errors: errors.slice(0, 10) };
}
export function formatControl(value) {
  if (typeof value === 'boolean') return value ? 'zapnuto' : 'vypnuto';
  if (value && typeof value === 'object') return value.target ? `${value.target}${value.goal ? ` ×${value.goal}` : ''}` : 'žádný';
  return String(value);
}

// Emits 'state' (id, state) whenever a running character reports a new position,
// and 'log' (entry) for every new log entry.
export class Runtime extends EventEmitter {
  constructor(config, store, browserType = chromium, gameApi = null) {
    super();
    this.config = config; this.store = store; this.browserType = browserType;
    this.gameApi = gameApi; this.nextCodeSync = 0;
    this.browser = null; this.sessions = new Map(); this.logs = [];
    this.queue = Promise.resolve(); this.closing = false; this.sequence = 0;
    this.timer = null; this.notifier = null; this.stats = new Map();
    // Optional persistent journal and long-term samples (History); server events per realm ("EU I").
    this.history = null; this.servers = new Map();
  }
  // Adds a structured entry to the persistent journal; the character's name is kept for when it is deleted.
  journal(id, type, message, extra = {}) {
    const name = id ? this.sessions.get(id)?.character?.name || this.store.snapshot().characters.find(c => c.id === id)?.name || null : null;
    this.history?.record({ type, characterId: id, name, message: this.redact(message), ...extra });
  }
  log(id, level, message) {
    const text = this.redact(message);
    const entry = { id: ++this.sequence, at: new Date().toISOString(), characterId: id, level, message: text.slice(0, 4000) };
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.shift();
    this.emit('log', entry);
  }
  redact(message) {
    let text = String(message);
    const cookie = this.config.authCookie || '';
    const auth = cookie.includes('-') ? cookie.slice(cookie.indexOf('-') + 1) : cookie;
    for (const secret of [cookie, auth, ...cookie.split('-')].filter(s => s.length >= 8)) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  exclusive(fn) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    const browser = await this.browserType.launch({ headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    this.browser = browser;
    browser.on('disconnected', () => {
      if (this.closing) return;
      this.log(null, 'error', 'Chromium se odpojil; aktivní postavy budou obnoveny.');
      for (const session of this.sessions.values()) {
        session.status = 'reconnecting'; session.nextRetry = Date.now() + 10_000;
      }
    });
    return browser;
  }
  async init() {
    for (const character of this.store.snapshot().characters.filter(c => c.autoStart)) {
      await this.start(character.id).catch(error => this.log(character.id, 'error', error.message));
    }
    if (!this.closing) {
      this.timer = setInterval(() => { this.exclusive(() => this.tick()).catch(error => this.log(null, 'error', error.message)); }, 5000);
      this.timer.unref();
    }
  }
  start(id) { return this.exclusive(() => this.startInternal(id)); }
  async startInternal(id) {
    if (this.closing) throw new Error('Server se vypíná.');
    const character = this.store.snapshot().characters.find(c => c.id === id);
    if (!character) throw new Error('Postava neexistuje.');
    if (!this.config.authCookie) throw new Error('Připoj herní účet v panelu nebo nastav AL_AUTH_COOKIE.');
    if (this.sessions.has(id)) return;
    if (this.sessions.size >= this.config.maxCharacters) throw new Error('Dosažen limit aktivních postav.');
    const downloadFailed = error => Object.assign(new Error(`Stažení CODE před startem selhalo: ${this.redact(error.message)}`), { status: 502 });
    if (character.scriptId) {
      const script = this.store.snapshot().scripts.find(s => s.id === character.scriptId);
      if (!script?.remoteSlot) throw Object.assign(new Error('Propoj CODE s herním slotem. Místní návrh nelze spustit.'), { status: 409 });
      if (!this.gameApi?.status().configured) throw Object.assign(new Error('Pro společný herní CODE připoj API token.'), { status: 409 });
    }
    // Download the current slot before logging in, so a missing or unreachable CODE stops the start early.
    let scriptId, prefetched;
    try { scriptId = await this.resolveScript(character); prefetched = await this.downloadScript(scriptId); }
    catch (error) { throw downloadFailed(error); }
    if (prefetched) this.log(id, 'info', `CODE stažen ze slotu ${prefetched.remoteSlot} (verze ${prefetched.remoteVersion}): ${prefetched.name}`);
    const session = { id, character, scriptId, status: 'starting', context: null, page: null, state: null, attempts: 0, nextRetry: 0, startedAt: new Date().toISOString(), error: null, prefetched };
    this.sessions.set(id, session);
    this.journal(id, 'start', `Spuštěno na ${character.region} ${character.server}.`);
    try { await this.connect(session); }
    catch (error) { this.failed(session, error); }
  }
  async connect(session) {
    // Only the first connection uses the copy downloaded by start; reconnects download again,
    // and a character with automatic CODE looks up its current default slot again.
    const first = session.prefetched !== undefined, prefetched = session.prefetched; session.prefetched = undefined;
    if (!first) session.scriptId = await this.resolveScript(session.character);
    if (session.context) await withDeadline(session.context.close(), 5000).catch(() => {});
    session.context = null; session.page = null; session.state = null;
    session.status = 'starting';
    const browser = await this.getBrowser();
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    session.context = context;
    await context.addCookies([{ name: this.config.cookieName, value: this.config.authCookie, domain: 'adventure.land', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    // A fresh context prevents a cached game script from starting unexpectedly.
    const page = await context.newPage(); session.page = page;
    page.setDefaultTimeout(15_000);
    page.on('console', message => this.log(session.id, message.type() === 'error' ? 'error' : 'info', message.text()));
    page.on('pageerror', error => this.log(session.id, 'error', error.message));
    page.on('request', request => this.trackModule(session, page, request.url()));
    // Check account ownership and presence on the selection page before logging in.
    const selection = new URL(`/server/${encodeURIComponent(session.character.region)}/${encodeURIComponent(session.character.server)}/`, GAME_ORIGIN);
    selection.searchParams.set('no_graphics', 'true');
    selection.searchParams.set('no_html', 'true');
    await page.goto(selection.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(() => typeof window.user_id === 'string', null, { timeout: 15_000 });
    const authenticated = await withDeadline(page.evaluate(() => !!window.user_id));
    if (!authenticated) throw new Error('Přihlášení ke hře selhalo. Obnov přihlášení v dialogu Herní účet.');
    await page.waitForFunction(() => Array.isArray(window.X?.characters) && Array.isArray(window.X?.servers), null, { timeout: 30_000 });
    // Do not take over a character that is already connected elsewhere.
    const ownership = await withDeadline(page.evaluate(character => {
      const owned = window.X.characters.find(c => c.name?.toLowerCase() === character.name.toLowerCase());
      const realm = window.X.servers.some(s => s.region === character.region && s.name === character.server);
      return { exists: !!owned, online: !!owned?.online, realm };
    }, session.character));
    if (!ownership.exists) throw new Error('Postava nepatří přihlášenému účtu.');
    if (!ownership.realm) throw new Error('Zadaný herní server není dostupný. Zkontroluj region a jméno serveru.');
    if (ownership.online) throw new Error('Postava už je online. Nejdřív ji odpoj v původním klientu.');
    await page.goto(characterUrl(session.character), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(name => window.character?.name?.toLowerCase() === name.toLowerCase() && window.socket?.connected && typeof window.start_runner === 'function', session.character.name, { timeout: 45_000 });
    await withDeadline(page.evaluate(() => {
      // Capture game/CODE output without forwarding chat or account credentials.
      for (const name of ['add_log', 'add_codelog']) {
        const original = window[name];
        if (typeof original !== 'function') continue;
        window[name] = function (message, ...args) {
          const text = document.createElement('div'); text.innerHTML = String(message);
          console.log(`[${name === 'add_codelog' ? 'CODE' : 'GAME'}] ${text.textContent}`);
          return original.call(this, message, ...args);
        };
      }
    }));
    // The page pushes changed state itself, so the live map does not wait for the 5 s tick.
    await page.exposeFunction('__mainframeState', json => this.pushState(session, page, json));
    await withDeadline(page.evaluate(interval => {
      // Without graphics the game moves entities only when it draws, about every 300 ms while CODE runs and every
      // 15 s otherwise, so real_x lags behind the sampling time by a varying amount. Positions are carried forward
      // from the last draw to the given time the way the game's draw and stop_logic would move them.
      const position = window.__mainframePosition = (e, now) => {
        let x = e.real_x ?? e.x, y = e.real_y ?? e.y;
        const since = Math.min(Math.max(now - (window.last_draw?.getTime?.() ?? now), 0), 20_000) / 1000;
        if (since && e.moving && Number.isFinite(e.vx) && Number.isFinite(e.vy) && Number.isFinite(e.going_x) && Number.isFinite(e.going_y)) {
          x += e.vx * since; y += e.vy * since;
          if (e.vx > 0 ? x > e.going_x : e.vx < 0 && x < e.going_x) x = e.going_x;
          if (e.vy > 0 ? y > e.going_y : e.vy < 0 && y < e.going_y) y = e.going_y;
        }
        return [x, y];
      };
      window.__mainframeSnapshot = () => {
        const c = window.character;
        if (!c || !window.socket?.connected) return null;
        const now = Date.now(), [x, y] = position(c, now);
        // Nearest visible monsters and players for the live map.
        const nearby = Object.values(window.entities || {}).filter(e => e && !e.dead && !e.rip && e.map === c.map && Number.isFinite(e.real_x ?? e.x) && Number.isFinite(e.real_y ?? e.y))
          .map(e => { const [ex, ey] = position(e, now); return { id: String(e.id ?? e.name ?? '').slice(0, 40), kind: e.type === 'monster' ? 'monster' : 'character', name: String(e.type === 'monster' ? e.mtype : e.name).slice(0, 40), x: Math.round(ex), y: Math.round(ey), target: e.target === c.name, stand: e.type !== 'monster' && !!e.stand }; })
          .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 60);
        return { name: c.name, ctype: c.ctype, level: c.level, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, gold: c.gold, xp: c.xp, map: c.map, x, y, rip: !!c.rip, ping: c.ping, stand: !!c.stand, codeRunning: !!window.code_active, nearby, target: typeof c.target === 'string' ? c.target : null, at: now };
      };
      clearInterval(window.__mainframeTimer);
      let last = '';
      window.__mainframeTimer = setInterval(() => {
        const state = window.__mainframeSnapshot();
        if (!state) return;
        const { at, ...rest } = state, json = JSON.stringify(rest);
        if (json === last) return;
        // The sampling time lets the map replay movement at its real pace, whatever the delivery delays.
        last = json; window.__mainframeState(JSON.stringify(state)).catch(() => {});
      }, interval);
    }, LIVE_INTERVAL));
    await this.loadScript(session, prefetched);
    const attempts = session.attempts;
    const saved = this.store.snapshot().characters.find(c => c.id === session.id)?.controls || {};
    session.pendingControls = Object.keys(saved).length ? { values: { ...saved }, until: Date.now() + 60_000 } : null;
    session.status = 'running'; session.error = null; session.attempts = 0; session.lastActivityAt = Date.now();
    this.journal(session.id, 'connected', attempts ? `Znovu připojeno po ${attempts} ${attempts === 1 ? 'výpadku' : 'neúspěšných pokusech'} (${session.character.region} ${session.character.server}).` : `Připojeno (${session.character.region} ${session.character.server}).`);
    this.log(session.id, 'info', `Připojeno: ${session.character.name} / ${session.character.region} ${session.character.server}`);
  }
  // The script a session runs: the assigned one, or with automatic CODE the character's current default slot.
  async resolveScript(character) {
    if (character.scriptId) return character.scriptId;
    return (await this.detectDefaultScript(character))?.id || null;
  }
  // Finds the character's own default game slot and links it as a shared script. The character keeps
  // automatic CODE, so every start and reconnect looks the default slot up again.
  async detectDefaultScript(character) {
    if (!this.gameApi?.status().configured) return null;
    const slot = await this.gameApi.defaultSlot(character.name);
    if (!slot) { this.log(character.id, 'info', 'Výchozí CODE slot postavy nebyl nalezen; postava poběží bez CODE.'); return null; }
    let current;
    try { current = await this.gameApi.getCode(slot); }
    catch (error) {
      if (error.status !== 404) throw error;
      this.log(character.id, 'info', `Výchozí CODE slot postavy (${slot}) je prázdný; postava poběží bez CODE.`); return null;
    }
    const script = await this.store.update(state => {
      const updatedAt = new Date().toISOString();
      let linked = state.scripts.find(s => s.remoteSlot === slot);
      if (linked) Object.assign(linked, current, { updatedAt });
      else {
        if (state.scripts.length >= 100) throw new Error('Limit je 100 skriptů.');
        linked = { ...current, id: randomUUID(), updatedAt }; state.scripts.push(linked);
      }
      return linked;
    });
    this.log(character.id, 'info', `Výchozí CODE postavy: slot ${slot} (${script.name}).`);
    return script;
  }
  // The script a session runs; sessions created before resolving it fall back to the character's assignment.
  scriptIdOf(session) {
    return session.scriptId !== undefined ? session.scriptId : this.store.snapshot().characters.find(c => c.id === session.id)?.scriptId ?? null;
  }
  // Running characters whose CODE comes from the script, including characters with automatic CODE.
  usesScript(scriptId) {
    return [...this.sessions.values()].some(session => this.scriptIdOf(session) === scriptId);
  }
  // Reads the script's current CODE from its game slot and refreshes the local copy.
  async downloadScript(scriptId, fetched = null) {
    const script = this.store.snapshot().scripts.find(s => s.id === scriptId);
    if (!scriptId) return null;
    if (!script) throw new Error('Přiřazený skript neexistuje.');
    if (!script.remoteSlot || !this.gameApi) throw new Error('Propoj CODE s herním slotem a připoj API token.');
    const current = fetched || await this.gameApi.getCode(script.remoteSlot);
    if (current.remoteSlot !== script.remoteSlot) throw new Error('CODE slot nesouhlasí.');
    await this.store.update(state => {
      const cached = state.scripts.find(s => s.id === script.id);
      Object.assign(cached, current, { updatedAt: new Date().toISOString() });
    });
    return { ...script, ...current };
  }
  async loadScript(session, fetched = null) {
    const script = await this.downloadScript(this.scriptIdOf(session), fetched);
    session.modules = new Map();
    await withDeadline(session.page.evaluate(source => {
      if (window.code_run) window.stop_runner();
      if (source) window.start_runner('maincode', source);
    }, script?.source || ''));
    if (script?.source) await session.page.waitForFunction(() => window.code_active === true, null, { timeout: 15_000 });
    const changed = session.code?.version !== script?.remoteVersion || session.code?.slot !== script?.remoteSlot || session.code?.error;
    session.codeHash = script ? createHash('sha256').update(script.source).digest('hex') : null;
    if (script && changed) this.journal(session.id, 'code', `CODE ${script.name} (slot ${script.remoteSlot}, verze ${script.remoteVersion}) načten.`);
    session.code = script ? { slot: script.remoteSlot, version: script.remoteVersion, syncedAt: new Date().toISOString(), error: null } : null;
    this.log(session.id, 'info', script ? `CODE: ${script.name}` : 'Postava připojena bez CODE.');
    // Remember the versions of modules loaded at start; a failed check is retried by the next sync.
    if (session.modules.size && this.gameApi?.status().configured) await this.gameApi.listCodes().then(codes => this.changedModules(session, codes)).catch(() => {});
  }
  // require_code() and load_code() in the game runner fetch other CODE slots from /code.js?name=<slot or name>.
  trackModule(session, page, url) {
    if (session.page !== page || !session.modules) return;
    let parsed;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.origin !== GAME_ORIGIN || parsed.pathname !== '/code.js') return;
    const name = parsed.searchParams.get('name');
    if (name && name.length <= 80 && !session.modules.has(name)) session.modules.set(name, null);
  }
  // Records the first seen version of each loaded module and returns the modules whose slot changed since.
  changedModules(session, codes) {
    const changed = [];
    for (const [name, version] of session.modules || []) {
      const code = codes.find(c => c.slot === name) || codes.find(c => c.name === name);
      if (!code) continue;
      if (version === null) session.modules.set(name, code.version);
      else if (version !== code.version) changed.push(`${name} (verze ${version} → ${code.version})`);
    }
    return changed;
  }
  reload(id) { return this.exclusive(async () => {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw new Error('Postava není připojena.');
    try { await this.loadScript(session); }
    catch (error) { await this.pauseCode(session, error); throw error; }
  }); }
  async pauseCode(session, error) {
    const message = 'Synchronizace CODE selhala; běh pozastaven: ' + this.redact(error.message);
    // If the runner cannot be stopped, close its game context instead of leaving stale CODE running.
    try { await withDeadline(session.page.evaluate(() => { if (window.code_run) window.stop_runner(); }), 5000); }
    catch { await withDeadline(session.context?.close() || Promise.resolve(), 5000).catch(() => {}); this.failed(session, new Error(message)); }
    session.codeHash = null;
    if (session.code?.error !== message) { this.log(session.id, 'error', message); this.journal(session.id, 'code_error', message); }
    session.code = { ...session.code, error: message };
  }
  async applySharedScript(script) {
    const hash = createHash('sha256').update(script.source).digest('hex');
    for (const session of this.sessions.values()) {
      if (session.status !== 'running' || this.scriptIdOf(session) !== script.id) continue;
      try {
        if (session.codeHash !== hash || session.code?.error) await this.loadScript(session, script);
        else session.code = { slot: script.remoteSlot, version: script.remoteVersion, syncedAt: new Date().toISOString(), error: null };
      } catch (error) { await this.pauseCode(session, error); }
    }
  }
  async syncSharedScripts() {
    if (Date.now() < this.nextCodeSync) return;
    this.nextCodeSync = Date.now() + 30_000;
    const ids = new Set([...this.sessions.values()].filter(s => s.status === 'running').map(s => this.scriptIdOf(s)).filter(Boolean));
    for (const id of ids) {
      const script = this.store.snapshot().scripts.find(s => s.id === id);
      try {
        if (!script?.remoteSlot || !this.gameApi) throw new Error('Chybí propojený CODE slot nebo API token.');
        const current = await this.gameApi.getCode(script.remoteSlot);
        if (current.source !== script.source || current.remoteVersion !== script.remoteVersion || current.name !== script.name) {
          await this.store.update(state => Object.assign(state.scripts.find(s => s.id === id), current, { updatedAt: new Date().toISOString() }));
        }
        await this.applySharedScript({ ...script, ...current });
      } catch (error) {
        for (const session of this.sessions.values()) if (session.status === 'running' && this.scriptIdOf(session) === id) await this.pauseCode(session, error);
      }
    }
    await this.syncModules();
  }
  // A main slot that only calls require_code("99") keeps its version when slot 99 changes, so loaded modules are checked too.
  async syncModules() {
    const watched = [...this.sessions.values()].filter(s => s.status === 'running' && s.modules?.size && !s.code?.error);
    if (!watched.length || !this.gameApi?.status().configured) return;
    let codes;
    try { codes = await this.gameApi.listCodes(); this.moduleSyncError = null; }
    catch (error) {
      const message = `Kontrola modulů CODE selhala: ${this.redact(error.message)}`;
      if (this.moduleSyncError !== message) this.log(null, 'error', message);
      this.moduleSyncError = message; return;
    }
    for (const session of watched) {
      const changed = this.changedModules(session, codes);
      if (!changed.length) continue;
      this.log(session.id, 'info', `Změnil se modul CODE ${changed.join(', ')}; načítám CODE znovu.`);
      try { await this.loadScript(session); } catch (error) { await this.pauseCode(session, error); }
    }
  }
  async inventory(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    const snapshot = await withDeadline(session.page.evaluate(() => {
      const c = window.character;
      if (!c || !window.socket?.connected || c.rip) return null;
      return { name: c.name, gold: c.gold, items: (c.items || []).flatMap((item, index) => item ? [{
        index, name: item.name, level: item.level || 0, quantity: item.q || 1,
        locked: !!(item.l || item.b || item.acl || item.name === 'placeholder'), serialized: JSON.stringify(item),
      }] : []) };
    }));
    if (!snapshot) throw Object.assign(new Error('Postava je mrtvá nebo se odpojila.'), { status: 409 });
    return snapshot;
  }
  // Live inventory, equipment and (inside the bank) bank packs; the caller sanitizes items.
  async details(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    const snapshot = await withDeadline(session.page.evaluate(() => {
      const c = window.character;
      if (!c || !window.socket?.connected) return null;
      const copy = value => value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : null;
      return { name: c.name, ctype: c.ctype, level: c.level, gold: c.gold, isize: c.isize, map: c.map, items: copy(c.items) || [], slots: copy(c.slots), bank: copy(c.bank) };
    }));
    if (!snapshot) throw Object.assign(new Error('Postava se odpojila.'), { status: 409 });
    return snapshot;
  }
  // Values the character's CODE saved with set(); the caller shapes them with storageView.
  async storage(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    const entries = await withDeadline(session.page.evaluate(prefix => Object.keys(window.localStorage).filter(key => key.startsWith(prefix))
      .map(key => ({ key: key.slice(prefix.length), value: window.localStorage.getItem(key) })), STORAGE_PREFIX));
    return entries.map(e => ({ ...e, key: this.redact(e.key), value: typeof e.value === 'string' ? this.redact(e.value) : e.value }));
  }
  // Writes a JSON text exactly as CODE set(key, value) would; null removes the key so get(key) returns null.
  async setStorage(id, key, value) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    return withDeadline(session.page.evaluate(({ name, text }) => {
      const existed = window.localStorage.getItem(name) !== null;
      if (text === null) window.localStorage.removeItem(name); else window.localStorage.setItem(name, text);
      return existed;
    }, { name: STORAGE_PREFIX + key, text: value }));
  }
  // Removes every value CODE saved with set(); other game client keys stay untouched.
  async clearStorage(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    return withDeadline(session.page.evaluate(prefix => {
      const keys = Object.keys(window.localStorage).filter(key => key.startsWith(prefix));
      for (const key of keys) window.localStorage.removeItem(key);
      return keys.length;
    }, STORAGE_PREFIX));
  }
  liveSession(id) {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw Object.assign(new Error('Postava není připojena.'), { status: 409 });
    return session;
  }
  async evaluateControls(session, input) {
    const result = await withDeadline(session.page.evaluate(pageControls, input));
    if (!result || typeof result !== 'object' || JSON.stringify(result).length > 200_000) throw new Error('CODE vrátil neočekávaná data.');
    if (result.running === false) throw Object.assign(new Error('CODE postavy neběží.'), { status: 409 });
    return JSON.parse(this.redact(JSON.stringify(result)));
  }
  // What the character's CODE lets the panel set, and what it reports doing.
  async controls(id) { return this.evaluateControls(this.liveSession(id), { action: 'list' }); }
  async setControl(id, key, value) {
    const session = this.liveSession(id);
    const result = await this.evaluateControls(session, { action: 'set', key, value });
    if (result.ok) {
      if (session.pendingControls) delete session.pendingControls.values[key];
      this.log(id, 'info', `Automatizace: ${result.label} = ${formatControl(result.value)}`);
    }
    return result;
  }
  // Calls the CODE's handle_command(name, args) the way a chat command typed in the game does; nothing is sent to chat.
  async runCommand(id, name, args) {
    const result = await this.evaluateControls(this.liveSession(id), { action: 'command', name, args });
    if (result.ok) this.log(id, 'info', `Automatizace: příkaz /${name}${args ? ` ${args}` : ''}`);
    return result;
  }
  // A new connection starts with empty CODE storage, so remembered values are set again once the CODE offers them.
  async applySavedControls(session) {
    const pending = session.pendingControls, entries = Object.entries(pending.values);
    let results = [];
    try { results = entries.length ? (await this.evaluateControls(session, { action: 'apply', values: entries })).results : []; }
    catch (error) { if (error.status !== 409) throw error; }
    const applied = [];
    for (const r of results) {
      if (r.ok) { applied.push(`${r.label} = ${formatControl(r.value)}`); delete pending.values[r.key]; }
      else if (!r.missing) { this.log(session.id, 'error', `Automatizace: zapamatovanou hodnotu ${r.label || r.key} nelze nastavit – ${r.message}`); delete pending.values[r.key]; }
    }
    if (applied.length) this.log(session.id, 'info', `Automatizace po připojení: ${applied.join(', ')}`);
    const left = Object.keys(pending.values);
    if (!left.length) session.pendingControls = null;
    else if (Date.now() > pending.until) {
      session.pendingControls = null;
      this.log(session.id, 'error', `Automatizace: CODE do minuty po startu nenabídl ${left.join(', ')}; hodnoty zůstávají zapamatované pro další připojení.`);
    }
  }
  sessionByName(name) {
    return [...this.sessions.values()].find(s => s.status === 'running' && s.character.name.toLowerCase() === name.toLowerCase()) || null;
  }
  async sendTransfer(command) {
    const session = this.sessions.get(command.characterId);
    try {
      return await withDeadline(session.page.evaluate(async input => {
        const c = window.character, runner = document.getElementById('maincode')?.contentWindow;
        const failed = message => ({ status: 'failed', message });
        if (!c || !window.socket?.connected || c.rip) return failed('Postava je mrtvá nebo odpojená.');
        if (!window.code_active || !runner || typeof runner.send_gold !== 'function' || typeof runner.send_item !== 'function') return failed('Pro převod musí běžet CODE postavy.');
        if (c.name.toLowerCase() === input.to.toLowerCase()) return failed('Příjemce musí být jiná postava.');
        if (input.type === 'gold' && c.gold < input.amount) return failed('Postava už nemá dost zlata.');
        if (input.type === 'item') {
          const item = c.items?.[input.index];
          if (!item || JSON.stringify(item) !== input.expectedItem) return failed('Inventář se změnil. Připrav nový převod.');
          if (item.l || item.b || item.acl || item.name === 'placeholder') return failed('Předmět je zamčený nebo blokovaný.');
          if ((item.q || 1) < input.quantity) return failed('Nedostatek předmětů.');
        }
        let result;
        try {
          result = await (input.type === 'gold' ? runner.send_gold(input.to, input.amount) : runner.send_item(input.to, input.index, input.quantity));
        } catch (error) {
          const reasons = { distance: 'Příjemce musí být poblíž na stejné mapě.', receiver_unavailable: 'Příjemce není dostupný na tomto serveru.', send_no_space: 'Příjemce nemá místo v inventáři.', item_locked: 'Předmět je zamčený.', item_blocked: 'Předmět je blokovaný.', cant_in_bank: 'Převod nelze provést v bance.', send_no_item: 'Předmět už není v inventáři.' };
          if (reasons[error?.reason]) return failed(reasons[error.reason]);
          return { status: 'unknown', message: 'Výsledek převodu není potvrzen. Zkontroluj inventář a herní logy před dalším pokusem.' };
        }
        if (result?.response === (input.type === 'gold' ? 'gold_sent' : 'item_sent') && result.name?.toLowerCase() === input.to.toLowerCase() &&
          (input.type === 'gold' || (result.item === input.itemName && result.num === input.index && result.q === input.quantity))) {
          return { status: 'confirmed', message: 'Herní server potvrdil převod.', receivedGold: input.type === 'gold' ? result.gold : undefined };
        }
        return { status: 'unknown', message: 'Výsledek převodu není potvrzen. Zkontroluj inventář a herní logy před dalším pokusem.' };
      }, command), 12_000);
    } catch {
      return { status: 'unknown', message: 'Spojení během převodu selhalo nebo vypršelo. Zkontroluj inventář a herní logy před dalším pokusem.' };
    }
  }
  pushState(session, page, json) {
    if (this.sessions.get(session.id) !== session || session.page !== page || session.status !== 'running') return;
    const state = sanitizeState(json);
    if (!state) return;
    // Live pushes carry position and vitals only; the tick adds conditions, cooldowns and party.
    session.state = session.state ? { ...session.state, ...state } : state;
    this.emit('state', session.id, session.state);
  }
  failed(session, error) {
    session.status = 'reconnecting'; session.error = String(error.message || error);
    session.state = null; this.emit('state', session.id, null);
    session.attempts += 1;
    session.nextRetry = Date.now() + Math.min(300_000, 10_000 * 2 ** Math.min(session.attempts - 1, 5));
    this.log(session.id, 'error', `${session.error}; další pokus za ${Math.round((session.nextRetry - Date.now()) / 1000)} s.`);
    // The first failure and then about one an hour at the longest retry delay, so a long outage does not flood the journal.
    if (session.attempts === 1 || session.attempts % 12 === 0) this.journal(session.id, 'disconnected', `${session.attempts > 1 ? `${session.attempts}. pokus: ` : ''}${session.error}`);
  }
  async tick() {
    if (this.closing) return;
    await this.syncSharedScripts();
    for (const session of this.sessions.values()) {
      if (session.status === 'reconnecting') {
        if (Date.now() < session.nextRetry) continue;
        try { await this.connect(session); } catch (error) { this.failed(session, error); }
        continue;
      }
      if (session.status !== 'running') continue;
      try {
        session.state = await withDeadline(session.page.evaluate(() => {
          const c = window.character;
          if (!c || !window.socket?.connected) return null;
          // Positions carried forward from the game's last draw, as in the page's own samples.
          const G = window.G || {}, now = Date.now(), position = window.__mainframePosition || (e => [e.real_x ?? e.x, e.real_y ?? e.y]);
          const [x, y] = position(c, now);
          // Nearest visible monsters and players for the live map.
          const nearby = Object.values(window.entities || {}).filter(e => e && !e.dead && !e.rip && e.map === c.map && Number.isFinite(e.real_x ?? e.x) && Number.isFinite(e.real_y ?? e.y))
            .map(e => { const [ex, ey] = position(e, now); return { id: String(e.id ?? e.name ?? '').slice(0, 40), kind: e.type === 'monster' ? 'monster' : 'character', name: String(e.type === 'monster' ? e.mtype : e.name).slice(0, 40), x: Math.round(ex), y: Math.round(ey), target: e.target === c.name, stand: e.type !== 'monster' && !!e.stand }; })
            .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 60);
          const items = Array.isArray(c.items) ? c.items : [];
          const count = pattern => items.reduce((sum, item) => sum + (item && pattern.test(item.name) ? (item.q || 1) : 0), 0);
          // Active conditions (character.s) classified by the game's own definitions.
          const conditions = Object.entries(c.s && typeof c.s === 'object' ? c.s : {}).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => {
            const definition = G.conditions?.[key];
            return { key, name: definition?.name, kind: definition?.debuff || definition?.bad ? 'debuff' : definition?.buff ? 'buff' : 'neutral', ms: value.ms };
          });
          // next_skill holds when each used skill becomes available again.
          let lastSkillAt = 0;
          const skills = Object.entries(window.next_skill && typeof window.next_skill === 'object' ? window.next_skill : {}).map(([key, value]) => {
            const at = value instanceof Date ? value.getTime() : Number(value);
            const cooldown = G.skills?.[key]?.cooldown;
            if (Number.isFinite(at) && Number.isFinite(cooldown)) lastSkillAt = Math.max(lastSkillAt, at - cooldown);
            else if (Number.isFinite(at)) lastSkillAt = Math.max(lastSkillAt, at);
            return { key, name: G.skills?.[key]?.name, ms: Number.isFinite(at) ? at - now : 0, cooldown };
          });
          const members = c.party && window.party && typeof window.party === 'object' ? Object.entries(window.party).map(([name, p]) => ({ name, ctype: p?.type, level: p?.level, map: p?.map, x: p?.x, y: p?.y })) : [];
          return { name: c.name, ctype: c.ctype, level: c.level, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, gold: c.gold, xp: c.xp, map: c.map, x, y, rip: !!c.rip, ping: c.ping, stand: !!c.stand, codeRunning: !!window.code_active, nearby, target: typeof c.target === 'string' ? c.target : null, at: now,
            // Server-wide events and bosses with their game names; sanitized by serverEventsView.
            // A value that cannot be copied must not fail the whole reading of the character.
            server: (() => {
              try { return { S: window.S && typeof window.S === 'object' ? JSON.parse(JSON.stringify(window.S)) : null, titles: Object.fromEntries(Object.keys(window.S && typeof window.S === 'object' ? window.S : {}).slice(0, 80).map(key => [key, G.events?.[key]?.name || G.monsters?.[key]?.name || null])) }; }
              catch { return null; }
            })(),
            extras: { max_xp: c.max_xp, isize: c.isize, esize: Number.isFinite(c.esize) ? c.esize : (c.isize || items.length) - items.filter(Boolean).length, potions: { hp: count(/^hpot/), mp: count(/^mpot/) }, conditions, skills, lastSkillAt, look: { skin: c.skin, cx: c.cx }, party: c.party ? { leader: c.party, members } : null } };
        }));
        if (!session.state) throw new Error('Herní spojení bylo přerušeno.');
        const { extras, server, ...state } = session.state;
        const previous = session.previousState;
        const { look, ...view } = extrasView(extras);
        session.state = { ...state, ...view, observedAt: new Date().toISOString() };
        session.server = serverEventsView(server);
        this.emit('state', session.id, session.state);
        await this.rememberLook(session, look).catch(error => this.log(session.id, 'error', `Vzhled postavy se nepodařilo uložit: ${this.redact(error.message)}`));
        await this.rememberStand(session).catch(error => this.log(session.id, 'error', `Pozici stánku se nepodařilo uložit: ${this.redact(error.message)}`));
        await this.observe(session, previous);
      } catch (error) { session.state = null; this.failed(session, error); }
    }
    for (const session of this.sessions.values()) await this.updateAlerts(session);
    for (const session of this.sessions.values()) {
      if (session.status !== 'running' || !session.pendingControls) continue;
      await this.applySavedControls(session).catch(error => this.log(session.id, 'error', `Automatizace: ${this.redact(error.message)}`));
    }
    this.updateServers();
  }
  // The last seen look stays saved, so the dashboard draws the character's sprite while it is offline too.
  async rememberLook(session, look) {
    if (!look || JSON.stringify(this.store.state.looks?.[session.id]) === JSON.stringify(look)) return;
    await this.store.update(state => { if (state.characters.some(c => c.id === session.id)) state.looks[session.id] = look; });
  }
  // Where the character was last seen with its merchant stand open, so the map shows it while the character is offline.
  // A stand seen closed is forgotten; an unchanged one is saved again at most every STAND_REFRESH to keep the time current.
  async rememberStand(session) {
    const state = session.state, saved = this.store.state.stands?.[session.id];
    if (!state.stand) {
      if (saved) await this.store.update(next => { delete next.stands[session.id]; });
      return;
    }
    const now = Date.now(), stand = { map: state.map, x: Math.round(state.x), y: Math.round(state.y), realm: `${session.character.region} ${session.character.server}` };
    if (saved && ['map', 'x', 'y', 'realm'].every(key => saved[key] === stand[key]) && now - Date.parse(saved.seenAt) < STAND_REFRESH) return;
    await this.store.update(next => { if (next.characters.some(c => c.id === session.id)) next.stands[session.id] = { ...stand, seenAt: new Date(now).toISOString() }; });
  }
  // One reading per realm, from the first running character there, so two clients cannot disagree about one boss.
  updateServers() {
    const seen = new Set(), now = Date.now();
    let notify = null;
    for (const session of this.sessions.values()) {
      if (session.status !== 'running' || !session.server || !session.character) continue;
      const realm = `${session.character.region} ${session.character.server}`;
      if (seen.has(realm)) continue;
      seen.add(realm);
      const previous = this.servers.get(realm), next = { realm, region: session.character.region, server: session.character.server, via: session.character.name, observedAt: now, ...session.server };
      this.servers.set(realm, next);
      if (!previous) continue;
      for (const change of eventTransitions(previous, next)) {
        const { event } = change, boss = event.kind === 'boss';
        const message = change.change === 'start' ? (boss ? `${change.title} je tady${event.map ? ` (mapa ${event.map})` : ''}.` : `Začala událost ${change.title}.`) : (boss ? `${change.title} zmizel nebo byl poražen.` : `Událost ${change.title} skončila.`);
        this.history?.record({ type: 'event', message: `${realm}: ${message}`, realm });
        notify ??= new Set(this.store.snapshot().settings?.notifyEvents || []);
        if (change.change === 'start' && notify.has(change.key)) this.notifier?.send(`${boss ? '🐉' : '🎉'} ${realm}: ${message}`).catch(() => {});
      }
    }
    // A realm without a running character has no current reading.
    for (const realm of [...this.servers.keys()]) if (!seen.has(realm)) this.servers.delete(realm);
  }
  serverEvents() { return [...this.servers.values()].sort((a, b) => a.realm.localeCompare(b.realm)); }
  // Feeds the XP/gold history and frozen-CODE detection; reloads CODE of an idle character when enabled.
  async observe(session, previous) {
    const now = Date.now(), state = session.state;
    session.previousState = state;
    if (!this.stats.has(session.id)) this.stats.set(session.id, []);
    addSample(this.stats.get(session.id), state, now);
    this.history?.sample(session.id, session.character.name, state);
    if (previous && !previous.rip && state.rip) this.journal(session.id, 'death', `Postava zemřela${state.map ? ` (mapa ${state.map})` : ''}.`);
    if (previous && state.level > previous.level) this.journal(session.id, 'level', `Dosažen level ${state.level}.`);
    if (!previous || isActivity(previous, state)) session.lastActivityAt = now;
    session.lastActivityAt ??= now;
    const character = session.character;
    const idleMinutes = character.idleMinutes ?? 10;
    if (!character.autoReloadIdle || !idleMinutes || state.rip || !session.code || session.code.error) return;
    if (now - session.lastActivityAt < idleMinutes * 60_000) return;
    this.log(session.id, 'error', `CODE nic nedělá ${Math.floor((now - session.lastActivityAt) / 60_000)} min; automaticky ho načítám znovu.`);
    session.autoReloads = (session.autoReloads || 0) + 1;
    session.lastActivityAt = now;
    try { await this.loadScript(session); } catch (error) { await this.pauseCode(session, error); }
  }
  async updateAlerts(session) {
    const now = Date.now();
    session.alerts = alertsFor(session, session.character, now);
    const active = new Set(session.alerts.map(a => a.type));
    session.notified ||= new Map();
    for (const alert of session.alerts) {
      if (session.activeAlerts?.has(alert.type)) continue;
      this.log(session.id, 'error', `Upozornění: ${alert.message}`);
      // Deaths and reconnects have their own journal entries.
      if (!['dead', 'reconnect'].includes(alert.type)) this.journal(session.id, 'alert', alert.message);
      if (now - (session.notified.get(alert.type) || 0) < NOTIFY_COOLDOWN) continue;
      session.notified.set(alert.type, now);
      // Delivery runs in the background so a slow webhook does not hold the runtime queue.
      this.notifier?.send(`⚠ ${session.character.name} (${session.character.region} ${session.character.server}): ${this.redact(alert.message)}`).catch(() => {});
    }
    session.activeAlerts = active;
  }
  forget(id) { this.stats.delete(id); }
  stop(id) { return this.exclusive(() => this.stopInternal(id)); }
  async stopInternal(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.journal(id, 'stop', this.closing ? 'Zastaveno při vypnutí serveru.' : 'Zastaveno.');
    this.sessions.delete(id); this.emit('state', id, null);
    if (session.context) await withDeadline(session.context.close(), 5000).catch(() => {});
    this.log(id, 'info', 'Postava odpojena.');
  }
  snapshot() {
    const now = Date.now();
    return [...this.sessions.values()].map(({ id, scriptId, status, state, error, nextRetry, startedAt, code, modules, alerts, lastActivityAt, autoReloads, attempts }) => ({
      id, scriptId: scriptId ?? null, status, state, error: error ? this.redact(error) : null, nextRetry, startedAt, attempts,
      code: code ? { ...code, modules: [...(modules || [])].map(([name, version]) => ({ name, version })) } : code,
      alerts: (alerts || []).map(a => ({ ...a, message: this.redact(a.message) })), idleMs: status === 'running' && lastActivityAt ? now - lastActivityAt : null, autoReloads: autoReloads || 0,
      stats: this.stats.has(id) ? summarizeStats(this.stats.get(id), status === 'running' ? state : null, now) : null,
    }));
  }
  async close() {
    this.closing = true; clearInterval(this.timer);
    await this.exclusive(async () => {
      for (const id of [...this.sessions.keys()]) await this.stopInternal(id);
      await this.browser?.close();
    });
  }
}
