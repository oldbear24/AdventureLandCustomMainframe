import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

export const GAME_ORIGIN = 'https://adventure.land';
export const LOG_LIMIT = 200;
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

export class Runtime {
  constructor(config, store, browserType = chromium, gameApi = null) {
    this.config = config; this.store = store; this.browserType = browserType;
    this.gameApi = gameApi; this.nextCodeSync = 0;
    this.browser = null; this.sessions = new Map(); this.logs = [];
    this.queue = Promise.resolve(); this.closing = false; this.sequence = 0;
    this.timer = null;
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
    const character = this.store.snapshot().characters.find(c => c.id === id);
    if (!character) throw new Error('Postava neexistuje.');
    if (!this.config.authCookie) throw new Error('Připoj herní účet v panelu nebo nastav AL_AUTH_COOKIE.');
    if (character.scriptId) {
      const script = this.store.snapshot().scripts.find(s => s.id === character.scriptId);
      if (!script?.remoteSlot) throw Object.assign(new Error('Propoj CODE s herním slotem. Místní návrh nelze spustit.'), { status: 409 });
      if (!this.gameApi?.status().configured) throw Object.assign(new Error('Pro společný herní CODE připoj API token.'), { status: 409 });
    }
    if (this.sessions.has(id)) return;
    if (this.sessions.size >= this.config.maxCharacters) throw new Error('Dosažen limit aktivních postav.');
    // Download the current slot before logging in, so a missing or unreachable CODE stops the start early.
    let prefetched;
    try { prefetched = await this.downloadScript(character); }
    catch (error) { throw Object.assign(new Error(`Stažení CODE před startem selhalo: ${this.redact(error.message)}`), { status: 502 }); }
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
    await this.loadScript(session, prefetched);
    session.status = 'running'; session.error = null; session.attempts = 0;
    this.log(session.id, 'info', `Připojeno: ${session.character.name} / ${session.character.region} ${session.character.server}`);
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
  failed(session, error) {
    session.status = 'reconnecting'; session.error = String(error.message || error);
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
          return { name: c.name, ctype: c.ctype, level: c.level, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, gold: c.gold, xp: c.xp, map: c.map, x: c.real_x ?? c.x, y: c.real_y ?? c.y, rip: !!c.rip, ping: c.ping, codeRunning: !!window.code_active };
        }));
        if (!session.state) throw new Error('Herní spojení bylo přerušeno.');
      } catch (error) { session.state = null; this.failed(session, error); }
    }
  }
  stop(id) { return this.exclusive(() => this.stopInternal(id)); }
  async stopInternal(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.context) await withDeadline(session.context.close(), 5000).catch(() => {});
    this.log(id, 'info', 'Postava odpojena.');
  }
  snapshot() {
    return [...this.sessions.values()].map(({ id, status, state, error, nextRetry, startedAt, code }) => ({ id, status, state, error: error ? this.redact(error) : null, nextRetry, startedAt, code }));
  }
  async close() {
    this.closing = true; clearInterval(this.timer);
    await this.exclusive(async () => {
      for (const id of [...this.sessions.keys()]) await this.stopInternal(id);
      await this.browser?.close();
    });
  }
}
