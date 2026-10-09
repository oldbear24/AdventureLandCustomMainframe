import { chromium } from 'playwright';

export const GAME_ORIGIN = 'https://adventure.land';
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
  constructor(config, store, browserType = chromium) {
    this.config = config; this.store = store; this.browserType = browserType;
    this.browser = null; this.sessions = new Map(); this.logs = [];
    this.queue = Promise.resolve(); this.closing = false; this.sequence = 0;
    this.timer = null;
  }
  log(id, level, message) {
    const text = this.redact(message);
    this.logs.push({ id: ++this.sequence, at: new Date().toISOString(), characterId: id, level, message: text.slice(0, 4000) });
    if (this.logs.length > 1000) this.logs.shift();
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
    if (!this.config.authCookie) throw new Error('Na serveru nastav AL_AUTH_COOKIE.');
    if (this.sessions.has(id)) return;
    if (this.sessions.size >= this.config.maxCharacters) throw new Error('Dosažen limit aktivních postav.');
    const session = { id, character, status: 'starting', context: null, page: null, state: null, attempts: 0, nextRetry: 0, startedAt: new Date().toISOString(), error: null };
    this.sessions.set(id, session);
    try { await this.connect(session); }
    catch (error) { this.failed(session, error); }
  }
  async connect(session) {
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
    if (!authenticated) throw new Error('Přihlášení ke hře selhalo. Obnov AL_AUTH_COOKIE a restartuj server.');
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
    await this.loadScript(session);
    session.status = 'running'; session.error = null; session.attempts = 0;
    this.log(session.id, 'info', `Připojeno: ${session.character.name} / ${session.character.region} ${session.character.server}`);
  }
  async loadScript(session) {
    const character = this.store.snapshot().characters.find(c => c.id === session.id);
    const script = this.store.snapshot().scripts.find(s => s.id === character?.scriptId);
    if (character?.scriptId && !script) throw new Error('Přiřazený skript neexistuje.');
    await withDeadline(session.page.evaluate(source => {
      if (window.code_run) window.stop_runner();
      if (source) window.start_runner('maincode', source);
    }, script?.source || ''));
    if (script?.source) await session.page.waitForFunction(() => window.code_active === true, null, { timeout: 15_000 });
    this.log(session.id, 'info', script ? `CODE: ${script.name}` : 'Postava připojena bez CODE.');
  }
  reload(id) { return this.exclusive(async () => {
    const session = this.sessions.get(id);
    if (!session || session.status !== 'running') throw new Error('Postava není připojena.');
    await this.loadScript(session);
  }); }
  failed(session, error) {
    session.status = 'reconnecting'; session.error = String(error.message || error);
    session.attempts += 1;
    session.nextRetry = Date.now() + Math.min(300_000, 10_000 * 2 ** Math.min(session.attempts - 1, 5));
    this.log(session.id, 'error', `${session.error}; další pokus za ${Math.round((session.nextRetry - Date.now()) / 1000)} s.`);
  }
  async tick() {
    if (this.closing) return;
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
    return [...this.sessions.values()].map(({ id, status, state, error, nextRetry, startedAt }) => ({ id, status, state, error: error ? this.redact(error) : null, nextRetry, startedAt }));
  }
  async close() {
    this.closing = true; clearInterval(this.timer);
    await this.exclusive(async () => {
      for (const id of [...this.sessions.keys()]) await this.stopInternal(id);
      await this.browser?.close();
    });
  }
}
