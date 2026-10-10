import { chromium } from 'playwright';
import { createHash, randomUUID } from 'node:crypto';
import { NOTIFY_COOLDOWN, addSample, alertsFor, extrasView, isActivity, summarizeStats } from './telemetry.js';
import { EventEmitter } from 'node:events';

export const GAME_ORIGIN = 'https://adventure.land';
export const LOG_LIMIT = 200;
// How often the game page pushes a changed position to the panel.
export const LIVE_INTERVAL = 250;
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
    .map(e => ({ kind: e.kind === 'monster' ? 'monster' : 'character', name: str(e.name), x: Math.round(e.x), y: Math.round(e.y), target: !!e.target }));
  return {
    name: str(state.name, 32), ctype: str(state.ctype, 20), level: num(state.level), hp: num(state.hp), max_hp: num(state.max_hp), mp: num(state.mp), max_mp: num(state.max_mp),
    gold: num(state.gold), xp: num(state.xp), map: str(state.map), x: num(state.x), y: num(state.y), rip: !!state.rip, ping: num(state.ping),
    codeRunning: !!state.codeRunning, nearby, target: typeof state.target === 'string' ? state.target.slice(0, 40) : null, observedAt: new Date().toISOString(),
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

// Emits 'state' (id, state) whenever a running character reports a new position.
export class Runtime extends EventEmitter {
  constructor(config, store, browserType = chromium, gameApi = null) {
    super();
    this.config = config; this.store = store; this.browserType = browserType;
    this.gameApi = gameApi; this.nextCodeSync = 0;
    this.browser = null; this.sessions = new Map(); this.logs = [];
    this.queue = Promise.resolve(); this.closing = false; this.sequence = 0;
    this.timer = null; this.notifier = null; this.stats = new Map();
  }
  log(id, level, message) {
    const text = this.redact(message);
    this.logs.push({ id: ++this.sequence, at: new Date().toISOString(), characterId: id, level, message: text.slice(0, 4000) });
    if (this.logs.length > LOG_LIMIT) this.logs.shift();
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
    let character = this.store.snapshot().characters.find(c => c.id === id);
    if (!character) throw new Error('Postava neexistuje.');
    if (!this.config.authCookie) throw new Error('Připoj herní účet v panelu nebo nastav AL_AUTH_COOKIE.');
    if (this.sessions.has(id)) return;
    if (this.sessions.size >= this.config.maxCharacters) throw new Error('Dosažen limit aktivních postav.');
    const downloadFailed = error => Object.assign(new Error(`Stažení CODE před startem selhalo: ${this.redact(error.message)}`), { status: 502 });
    if (!character.scriptId) {
      try { character = await this.detectDefaultScript(character); } catch (error) { throw downloadFailed(error); }
    }
    if (character.scriptId) {
      const script = this.store.snapshot().scripts.find(s => s.id === character.scriptId);
      if (!script?.remoteSlot) throw Object.assign(new Error('Propoj CODE s herním slotem. Místní návrh nelze spustit.'), { status: 409 });
      if (!this.gameApi?.status().configured) throw Object.assign(new Error('Pro společný herní CODE připoj API token.'), { status: 409 });
    }
    // Download the current slot before logging in, so a missing or unreachable CODE stops the start early.
    let prefetched;
    try { prefetched = await this.downloadScript(character); }
    catch (error) { throw downloadFailed(error); }
    if (prefetched) this.log(id, 'info', `CODE stažen ze slotu ${prefetched.remoteSlot} (verze ${prefetched.remoteVersion}): ${prefetched.name}`);
    const session = { id, character, status: 'starting', context: null, page: null, state: null, attempts: 0, nextRetry: 0, startedAt: new Date().toISOString(), error: null, prefetched };
    this.sessions.set(id, session);
    try { await this.connect(session); }
    catch (error) { this.failed(session, error); }
  }
  async connect(session) {
    // Only the first connection uses the copy downloaded by start; reconnects download again.
    const prefetched = session.prefetched; session.prefetched = null;
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
      window.__mainframeSnapshot = () => {
        const c = window.character;
        if (!c || !window.socket?.connected) return null;
        const x = c.real_x ?? c.x, y = c.real_y ?? c.y;
        // Nearest visible monsters and players for the live map.
        const nearby = Object.values(window.entities || {}).filter(e => e && !e.dead && !e.rip && e.map === c.map && Number.isFinite(e.real_x ?? e.x) && Number.isFinite(e.real_y ?? e.y))
          .map(e => ({ kind: e.type === 'monster' ? 'monster' : 'character', name: String(e.type === 'monster' ? e.mtype : e.name).slice(0, 40), x: Math.round(e.real_x ?? e.x), y: Math.round(e.real_y ?? e.y), target: e.target === c.name }))
          .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 60);
        return { name: c.name, ctype: c.ctype, level: c.level, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, gold: c.gold, xp: c.xp, map: c.map, x, y, rip: !!c.rip, ping: c.ping, codeRunning: !!window.code_active, nearby, target: typeof c.target === 'string' ? c.target : null };
      };
      clearInterval(window.__mainframeTimer);
      let last = '';
      window.__mainframeTimer = setInterval(() => {
        const state = window.__mainframeSnapshot();
        const json = state && JSON.stringify(state);
        if (!json || json === last) return;
        last = json; window.__mainframeState(json).catch(() => {});
      }, interval);
    }, LIVE_INTERVAL));
    await this.loadScript(session, prefetched);
    session.status = 'running'; session.error = null; session.attempts = 0; session.lastActivityAt = Date.now();
    this.log(session.id, 'info', `Připojeno: ${session.character.name} / ${session.character.region} ${session.character.server}`);
  }
  // A character without assigned CODE gets its own default game slot, linked as a shared script.
  async detectDefaultScript(character) {
    if (!this.gameApi?.status().configured) return character;
    const slot = await this.gameApi.defaultSlot(character.name);
    if (!slot) { this.log(character.id, 'info', 'Výchozí CODE slot postavy nebyl nalezen; postava poběží bez CODE.'); return character; }
    let current;
    try { current = await this.gameApi.getCode(slot); }
    catch (error) {
      if (error.status !== 404) throw error;
      this.log(character.id, 'info', `Výchozí CODE slot postavy (${slot}) je prázdný; postava poběží bez CODE.`); return character;
    }
    const script = await this.store.update(state => {
      const updatedAt = new Date().toISOString();
      let linked = state.scripts.find(s => s.remoteSlot === slot);
      if (linked) Object.assign(linked, current, { updatedAt });
      else {
        if (state.scripts.length >= 100) throw new Error('Limit je 100 skriptů.');
        linked = { ...current, id: randomUUID(), updatedAt }; state.scripts.push(linked);
      }
      const stored = state.characters.find(c => c.id === character.id);
      if (stored) stored.scriptId = linked.id;
      return linked;
    });
    this.log(character.id, 'info', `Detekován výchozí CODE postavy: slot ${slot} (${script.name}). Přiřazen k postavě.`);
    return { ...character, scriptId: script.id };
  }
  // Reads the character's current CODE from its game slot and refreshes the local copy.
  async downloadScript(character, fetched = null) {
    const script = this.store.snapshot().scripts.find(s => s.id === character?.scriptId);
    if (!character?.scriptId) return null;
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
    const character = this.store.snapshot().characters.find(c => c.id === session.id);
    const script = await this.downloadScript(character, fetched);
    await withDeadline(session.page.evaluate(source => {
      if (window.code_run) window.stop_runner();
      if (source) window.start_runner('maincode', source);
    }, script?.source || ''));
    if (script?.source) await session.page.waitForFunction(() => window.code_active === true, null, { timeout: 15_000 });
    session.codeHash = script ? createHash('sha256').update(script.source).digest('hex') : null;
    session.code = script ? { slot: script.remoteSlot, version: script.remoteVersion, syncedAt: new Date().toISOString(), error: null } : null;
    this.log(session.id, 'info', script ? `CODE: ${script.name}` : 'Postava připojena bez CODE.');
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
    if (session.code?.error !== message) this.log(session.id, 'error', message);
    session.code = { ...session.code, error: message };
  }
  async applySharedScript(script) {
    const hash = createHash('sha256').update(script.source).digest('hex');
    for (const session of this.sessions.values()) {
      const character = this.store.snapshot().characters.find(c => c.id === session.id);
      if (session.status !== 'running' || character?.scriptId !== script.id) continue;
      try {
        if (session.codeHash !== hash || session.code?.error) await this.loadScript(session, script);
        else session.code = { slot: script.remoteSlot, version: script.remoteVersion, syncedAt: new Date().toISOString(), error: null };
      } catch (error) { await this.pauseCode(session, error); }
    }
  }
  async syncSharedScripts() {
    if (Date.now() < this.nextCodeSync) return;
    this.nextCodeSync = Date.now() + 30_000;
    const ids = new Set([...this.sessions.values()].filter(s => s.status === 'running').map(s => this.store.snapshot().characters.find(c => c.id === s.id)?.scriptId).filter(Boolean));
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
        for (const session of this.sessions.values()) if (session.status === 'running' && this.store.snapshot().characters.find(c => c.id === session.id)?.scriptId === id) await this.pauseCode(session, error);
      }
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
  // Writes a JSON text exactly as CODE set(key, value) would; null removes the key like set(key, undefined).
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
          const x = c.real_x ?? c.x, y = c.real_y ?? c.y;
          // Nearest visible monsters and players for the live map.
          const nearby = Object.values(window.entities || {}).filter(e => e && !e.dead && !e.rip && e.map === c.map && Number.isFinite(e.real_x ?? e.x) && Number.isFinite(e.real_y ?? e.y))
            .map(e => ({ kind: e.type === 'monster' ? 'monster' : 'character', name: String(e.type === 'monster' ? e.mtype : e.name).slice(0, 40), x: Math.round(e.real_x ?? e.x), y: Math.round(e.real_y ?? e.y), target: e.target === c.name }))
            .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y)).slice(0, 60);
          const G = window.G || {}, now = Date.now(), items = Array.isArray(c.items) ? c.items : [];
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
          return { name: c.name, ctype: c.ctype, level: c.level, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, gold: c.gold, xp: c.xp, map: c.map, x, y, rip: !!c.rip, ping: c.ping, codeRunning: !!window.code_active, nearby, target: typeof c.target === 'string' ? c.target : null,
            extras: { max_xp: c.max_xp, isize: c.isize, esize: Number.isFinite(c.esize) ? c.esize : (c.isize || items.length) - items.filter(Boolean).length, potions: { hp: count(/^hpot/), mp: count(/^mpot/) }, conditions, skills, lastSkillAt, party: c.party ? { leader: c.party, members } : null } };
        }));
        if (!session.state) throw new Error('Herní spojení bylo přerušeno.');
        const { extras, ...state } = session.state;
        const previous = session.previousState;
        session.state = { ...state, ...extrasView(extras), observedAt: new Date().toISOString() };
        this.emit('state', session.id, session.state);
        await this.observe(session, previous);
      } catch (error) { session.state = null; this.failed(session, error); }
    }
    for (const session of this.sessions.values()) await this.updateAlerts(session);
  }
  // Feeds the XP/gold history and frozen-CODE detection; reloads CODE of an idle character when enabled.
  async observe(session, previous) {
    const now = Date.now(), state = session.state;
    session.previousState = state;
    if (!this.stats.has(session.id)) this.stats.set(session.id, []);
    addSample(this.stats.get(session.id), state, now);
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
    this.sessions.delete(id); this.emit('state', id, null);
    if (session.context) await withDeadline(session.context.close(), 5000).catch(() => {});
    this.log(id, 'info', 'Postava odpojena.');
  }
  snapshot() {
    const now = Date.now();
    return [...this.sessions.values()].map(({ id, status, state, error, nextRetry, startedAt, code, alerts, lastActivityAt, autoReloads, attempts }) => ({
      id, status, state, error: error ? this.redact(error) : null, nextRetry, startedAt, code, attempts,
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
