import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { characterSchema, scriptSchema } from './store.js';
import { Transfers, inventoryView, transferSchema } from './transfers.js';
import { equipmentView, goldOf, itemsView, packsView } from './inventory.js';
import { storageView } from './runtime.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createApp(config, store, runtime, account = null, gameApi = null, gameData = null) {
  const app = express(); app.disable('x-powered-by');
  const transfers = new Transfers(runtime);
  const sessions = new Map(), attempts = new Map(), gameAttempts = new Map();
  const salt = randomBytes(32), passwordHash = scryptSync(config.password, salt, 64);
  const usernameHash = createHash('sha256').update(config.username).digest();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
    for (const [key, value] of gameAttempts) if (value.until < now) gameAttempts.delete(key);
  }, 60_000); cleanup.unref();
  app.locals.dispose = () => clearInterval(cleanup);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      const expected = config.publicOrigin || `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') !== expected) return res.status(403).json({ error: 'Neplatný Origin. Použij panel nebo nastav PUBLIC_ORIGIN.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Vyžadováno application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 * 1000 };
  const sessionFor = req => {
    const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('mf_session='))?.slice(11);
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
    return { token, ...session };
  };
  app.locals.publicOrigin = config.publicOrigin;
  app.locals.sessionToken = req => sessionFor(req)?.token || null;
  app.locals.sessionActive = token => { const session = sessions.get(token); return !!session && session.expires >= Date.now(); };
  app.post('/api/login', (req, res) => {
    const { username, password } = z.object({ username: z.string().max(80).default('admin'), password: z.string().max(1024) }).parse(req.body);
    const key = req.ip;
    const counter = attempts.get(key) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (counter.until < Date.now()) { counter.count = 0; counter.until = Date.now() + 15 * 60 * 1000; }
    if (counter.count >= 10) { res.set('Retry-After', String(Math.ceil((counter.until - Date.now()) / 1000))); return res.status(429).json({ error: 'Příliš mnoho pokusů. Zkus to za 15 minut.' }); }
    const passwordMatches = timingSafeEqual(scryptSync(password, salt, 64), passwordHash);
    const usernameMatches = timingSafeEqual(createHash('sha256').update(username).digest(), usernameHash);
    if (!passwordMatches || !usernameMatches) {
      counter.count += 1; attempts.set(key, counter); return res.status(401).json({ error: 'Nesprávné přihlašovací jméno nebo heslo.' });
    }
    attempts.delete(key);
    const old = sessionFor(req); if (old) sessions.delete(old.token);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { expires: Date.now() + cookieOptions.maxAge });
    res.cookie('mf_session', token, cookieOptions).json({ ok: true });
  });
  app.use('/api', (req, res, next) => sessionFor(req) ? next() : res.status(401).json({ code: 'SESSION_REQUIRED', error: 'Přihlas se do panelu.' }));
  app.post('/api/logout', (req, res) => {
    const { token } = sessionFor(req); sessions.delete(token); app.locals.closeLive?.(token); res.clearCookie('mf_session', { ...cookieOptions, maxAge: undefined }).json({ ok: true });
  });
  app.get('/api/account', (_req, res) => res.json(account?.status() || { configured: !!config.authCookie, source: config.authCookie ? 'environment' : 'none', email: null, signedInAt: null }));
  app.use('/api/account', (req, _res, next) => {
    if (!account) throw new HttpError(503, 'Připojení herního účtu není dostupné.');
    next();
  });
  app.use('/api/account', (req, res, next) => {
    if (req.method !== 'POST' || !['/login', '/cookie', '/token'].includes(req.path)) return next();
    const current = gameAttempts.get(req.ip);
    const counter = current && current.until > Date.now() ? current : { count: 0, until: Date.now() + 15 * 60 * 1000 };
    if (counter.count >= 10) return res.status(429).json({ error: 'Příliš mnoho přihlášení ke hře. Zkus to za 15 minut.' });
    counter.count++; gameAttempts.set(req.ip, counter); next();
  });
  app.post('/api/account/login', async (req, res) => {
    const { email, password } = z.object({ email: z.email().max(254), password: z.string().min(1).max(1024) }).strict().parse(req.body);
    res.json(await account.login(email, password));
  });
  app.post('/api/account/cookie', async (req, res) => {
    const { cookie } = z.object({ cookie: z.string().trim().min(8).max(4096).regex(/^[^\s;\r\n]+$/) }).strict().parse(req.body);
    res.json(await account.setCookie(cookie));
  });
  app.post('/api/account/disconnect', async (_req, res) => res.json(await account.disconnect(store)));
  app.post('/api/account/token', async (req, res) => {
    if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
    const { token } = z.object({ token: z.string().regex(/^mcp_[A-Za-z0-9_-]{43}$/) }).strict().parse(req.body);
    res.json(await gameApi.connect(token));
  });
  app.post('/api/account/token/disconnect', async (_req, res) => {
    if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
    res.json(await gameApi.disconnect());
  });
  app.get('/api/owned-characters', async (_req, res) => {
    if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
    res.json(await gameApi.characters());
  });
  app.get('/api/code-slots', async (_req, res) => {
    if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
    res.json({ slots: await gameApi.listCodes() });
  });
  app.post('/api/code-slots/:slot/import', async (req, res) => {
    if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
    const slot = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(req.params.slot);
    const { scriptId } = z.object({ scriptId: z.uuid().nullable().default(null) }).strict().parse(req.body);
    const script = await runtime.exclusive(async () => {
      const snapshot = store.snapshot();
      const selected = scriptId ? snapshot.scripts.find(s => s.id === scriptId) : snapshot.scripts.find(s => s.remoteSlot === slot);
      if (scriptId && !selected) throw new HttpError(404, 'Místní skript neexistuje.');
      if (snapshot.scripts.some(s => s.remoteSlot === slot && s.id !== selected?.id)) throw new HttpError(409, 'Slot už je propojen s jiným skriptem. Vyber jej v editoru.');
      if (selected?.remoteSlot !== slot && snapshot.characters.some(c => c.scriptId === selected?.id && runtime.sessions.has(c.id))) throw new HttpError(409, 'Před změnou CODE slotu zastav přiřazené postavy.');
      const current = await gameApi.getCode(slot);
      const result = await store.update(state => {
        const existing = state.scripts.find(s => s.id === selected?.id);
        if (existing) { Object.assign(existing, current, { updatedAt: new Date().toISOString() }); return existing; }
        if (state.scripts.length >= 100) throw new HttpError(409, 'Limit je 100 skriptů.');
        const added = { ...current, id: randomUUID(), updatedAt: new Date().toISOString() }; state.scripts.push(added); return added;
      });
      await runtime.applySharedScript(result); return result;
    });
    res.json(script);
  });
  // Everything the character's CODE stored with set(name, value), read live from its game page.
  app.get('/api/characters/:id/storage', async (req, res) => res.json(storageView(await runtime.exclusive(() => runtime.storage(req.params.id)))));
  app.get('/api/characters/:id/inventory', async (req, res) => res.json(await runtime.exclusive(async () => inventoryView(await runtime.inventory(req.params.id)))));
  app.get('/api/maps', async (_req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    res.json(await gameData.mapList());
  });
  app.get('/api/maps/:name', async (req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(await gameData.map(req.params.name));
  });
  app.get('/api/item-sheets/:name', async (req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    const body = await gameData.sheet(req.params.name);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' }).send(body);
  });
  const itemNames = async () => gameData ? gameData.itemNames() : {};
  // A running character is read live; any other owned character comes from the saved account snapshot.
  app.get('/api/inventories/:name', async (req, res) => {
    const name = z.string().regex(/^[a-zA-Z0-9_]{1,32}$/).parse(req.params.name);
    const names = await itemNames();
    const live = await runtime.exclusive(async () => {
      const session = runtime.sessionByName(name);
      return session ? runtime.details(session.id) : null;
    });
    if (live) {
      return res.json({ name: live.name, class: String(live.ctype || ''), level: goldOf(live.level), source: 'live', observedAt: new Date().toISOString(), gold: goldOf(live.gold), size: goldOf(live.isize) || live.items.length, items: itemsView(live.items, names), equipment: equipmentView(live.slots, names) });
    }
    if (!gameApi?.status().configured) throw new HttpError(409, 'Postava neběží v panelu. Pro uložený inventář připoj API token.');
    const profile = await gameApi.profile(name);
    const items = Array.isArray(profile.inventory) ? profile.inventory : [];
    res.json({ name: typeof profile.name === 'string' ? profile.name : name, class: typeof profile.class === 'string' ? profile.class : '', level: goldOf(profile.level), source: 'saved', observedAt: typeof profile.synchronized_at === 'string' ? profile.synchronized_at : null, gold: goldOf(profile.gold), size: goldOf(profile.inventory_slots) || items.length, items: itemsView(items, names), equipment: equipmentView(profile.equipment, names) });
  });
  // The game only sends bank contents to a character standing in the bank; otherwise use the saved snapshot.
  app.get('/api/bank', async (_req, res) => {
    const names = await itemNames();
    const live = await runtime.exclusive(async () => {
      for (const session of runtime.sessions.values()) {
        if (session.status !== 'running' || !session.state?.map?.startsWith('bank')) continue;
        const details = await runtime.details(session.id).catch(() => null);
        if (details?.bank) return details;
      }
      return null;
    });
    if (live) return res.json({ source: 'live', observedAt: new Date().toISOString(), via: live.name, gold: goldOf(live.bank.gold), packs: packsView(live.bank, names) });
    if (!gameApi?.status().configured) throw new HttpError(409, 'Banka je živě vidět jen s postavou v bance. Pro uložený obsah připoj API token.');
    const bank = await gameApi.bank();
    res.json({ source: 'saved', observedAt: typeof bank.observed_at === 'string' ? bank.observed_at : null, retrievedAt: typeof bank.retrieved_at === 'string' ? bank.retrieved_at : new Date().toISOString(), via: null, gold: goldOf(bank.gold), packs: packsView(bank.packs, names) });
  });
  app.post('/api/transfers/prepare', async (req, res) => res.json(await transfers.prepare(transferSchema.parse(req.body), sessionFor(req).token)));
  app.post('/api/transfers/:id/confirm', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await transfers.confirm(z.uuid().parse(req.params.id), sessionFor(req).token));
  });
  app.get('/api/dashboard', (_req, res) => res.json({
    characters: store.snapshot().characters, scripts: store.snapshot().scripts.map(({ source, ...script }) => script),
    sessions: runtime.snapshot(), logs: runtime.logs,
    config: { authConfigured: !!config.authCookie, maxCharacters: config.maxCharacters, notifications: runtime.notifier?.status() || { discord: false, telegram: false } },
    account: account?.status() || { configured: !!config.authCookie, source: config.authCookie ? 'environment' : 'none', email: null, signedInAt: null },
    gameApi: gameApi?.status() || { configured: false },
    uptime: Math.floor(process.uptime()), now: Date.now(),
  }));
  app.post('/api/notifications/test', async (req, res) => {
    z.object({}).strict().parse(req.body);
    if (!runtime.notifier?.configured()) throw new HttpError(409, 'Nastav DISCORD_WEBHOOK_URL nebo TELEGRAM_BOT_TOKEN a TELEGRAM_CHAT_ID v .env.');
    const delivered = await runtime.notifier.send('✅ Testovací upozornění z Adventure Land Mainframe.');
    if (!delivered) throw new HttpError(502, 'Upozornění se nepodařilo doručit. Podrobnosti jsou v systémových logech.');
    res.json({ delivered });
  });
  // Start, stop or move several characters at once; each character reports its own result.
  const batchSchema = z.object({
    action: z.enum(['start', 'stop', 'move']), ids: z.array(z.uuid()).max(4).optional(),
    region: characterSchema.shape.region.optional(), server: characterSchema.shape.server.optional(),
  }).strict().refine(input => input.action !== 'move' || (input.region && input.server), 'Přesun vyžaduje region a server.');
  app.post('/api/characters/batch', async (req, res) => {
    const input = batchSchema.parse(req.body);
    const targets = store.snapshot().characters.filter(c => !input.ids || input.ids.includes(c.id));
    if (!targets.length) throw new HttpError(400, 'Žádná postava k provedení akce.');
    const results = [];
    const report = (character, error = null, skipped = false) => results.push({ id: character.id, name: character.name, ok: !error, skipped, error: error ? runtime.redact(error.message || error) : null });
    const startAll = async list => {
      for (const character of list) {
        try { await runtime.start(character.id); report(character); } catch (error) { report(character, error); }
      }
    };
    if (input.action === 'start') {
      const idle = targets.filter(c => !runtime.sessions.has(c.id));
      for (const character of targets.filter(c => runtime.sessions.has(c.id))) report(character, null, true);
      await startAll(idle);
    } else if (input.action === 'stop') {
      await runtime.exclusive(async () => {
        const ids = new Set(targets.map(c => c.id));
        await store.update(state => { for (const c of state.characters) if (ids.has(c.id)) c.autoStart = false; });
        for (const character of targets) { await runtime.stopInternal(character.id); report(character); }
      });
    } else {
      // Running characters are stopped, moved and started again; autostart is kept.
      const running = await runtime.exclusive(async () => {
        const active = targets.filter(c => runtime.sessions.has(c.id));
        for (const character of active) await runtime.stopInternal(character.id);
        const ids = new Set(targets.map(c => c.id));
        await store.update(state => { for (const c of state.characters) if (ids.has(c.id)) { c.region = input.region; c.server = input.server; } });
        return active;
      });
      for (const character of targets.filter(c => !running.includes(c))) report(character);
      await startAll(running);
    }
    res.json({ results });
  });
  app.post('/api/characters', async (req, res) => {
    const input = characterSchema.parse(req.body);
    const character = await store.update(state => {
      if (state.characters.length >= config.maxCharacters) throw new HttpError(409, 'Dosažen limit postav.');
      if (state.characters.some(c => c.name.toLowerCase() === input.name.toLowerCase())) throw new HttpError(409, 'Postava už je přidaná.');
      if (input.scriptId && !state.scripts.some(s => s.id === input.scriptId)) throw new HttpError(400, 'Skript neexistuje.');
      const result = { ...input, id: randomUUID() }; state.characters.push(result); return result;
    });
    res.status(201).json(character);
  });
  app.put('/api/characters/:id', async (req, res) => {
    const input = characterSchema.parse(req.body);
    await runtime.exclusive(async () => {
      if (runtime.sessions.has(req.params.id)) throw new HttpError(409, 'Před úpravou postavu zastav.');
      await store.update(state => {
        const index = state.characters.findIndex(c => c.id === req.params.id);
        if (index < 0) throw new HttpError(404, 'Postava neexistuje.');
        if (state.characters.some(c => c.id !== req.params.id && c.name.toLowerCase() === input.name.toLowerCase())) throw new HttpError(409, 'Duplicitní postava.');
        if (input.scriptId && !state.scripts.some(s => s.id === input.scriptId)) throw new HttpError(400, 'Skript neexistuje.');
        state.characters[index] = { ...input, id: req.params.id };
      });
    });
    res.json({ ok: true });
  });
  app.delete('/api/characters/:id', async (req, res) => {
    await runtime.exclusive(async () => {
      await runtime.stopInternal(req.params.id); runtime.forget(req.params.id);
      await store.update(state => { state.characters = state.characters.filter(c => c.id !== req.params.id); });
    }); res.json({ ok: true });
  });
  app.post('/api/characters/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (action === 'start') await runtime.start(id);
    else if (action === 'reload') await runtime.reload(id);
    else if (action === 'stop') await runtime.exclusive(async () => {
      await store.update(state => { const c = state.characters.find(c => c.id === id); if (c) c.autoStart = false; });
      await runtime.stopInternal(id);
    });
    else throw new HttpError(404, 'Neznámá akce.');
    res.json({ ok: true });
  });
  app.get('/api/scripts/:id', async (req, res) => {
    const script = await runtime.exclusive(async () => {
      const existing = store.snapshot().scripts.find(s => s.id === req.params.id);
      if (!existing) throw new HttpError(404, 'Skript neexistuje.');
      if (!existing.remoteSlot) return existing;
      if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
      const current = await gameApi.getCode(existing.remoteSlot);
      return store.update(state => { const cached = state.scripts.find(s => s.id === existing.id); Object.assign(cached, current, { updatedAt: new Date().toISOString() }); return cached; });
    });
    res.json(script);
  });
  app.post('/api/scripts', async (req, res) => {
    const input = scriptSchema.parse(req.body);
    const script = await store.update(state => {
      if (state.scripts.length >= 100) throw new HttpError(409, 'Limit je 100 skriptů.');
      const result = { ...input, id: randomUUID(), updatedAt: new Date().toISOString() }; state.scripts.push(result); return result;
    }); res.status(201).json(script);
  });
  app.put('/api/scripts/:id', async (req, res) => {
    const parsed = scriptSchema.extend({ expectedVersion: z.string().max(100).nullable().optional() }).parse(req.body);
    const { expectedVersion, ...input } = parsed;
    const saved = await runtime.exclusive(async () => {
      const script = store.snapshot().scripts.find(s => s.id === req.params.id);
      if (!script) throw new HttpError(404, 'Skript neexistuje.');
      let current = input;
      if (script.remoteSlot) {
        if (!gameApi) throw new HttpError(503, 'API připojení není dostupné.');
        if (typeof expectedVersion !== 'string') throw new HttpError(409, 'Načti aktuální verzi herního slotu před uložením.');
        current = await gameApi.saveCode(script.remoteSlot, input, expectedVersion);
      }
      const result = await store.update(state => { const cached = state.scripts.find(s => s.id === script.id); Object.assign(cached, current, { updatedAt: new Date().toISOString() }); return cached; });
      if (result.remoteSlot) await runtime.applySharedScript(result);
      return result;
    }); res.json(saved);
  });
  app.delete('/api/scripts/:id', async (req, res) => {
    await store.update(state => {
      if (state.characters.some(c => c.scriptId === req.params.id)) throw new HttpError(409, 'Skript je přiřazen postavě. Nejdřív změň přiřazení.');
      state.scripts = state.scripts.filter(s => s.id !== req.params.id);
    }); res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint neexistuje.' }));
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Neplatné údaje.', issues: error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) });
    const status = error.status || 500;
    let message = status === 500 ? 'Akce selhala. Zkontroluj konfiguraci a logy serveru.' : error.message;
    if (config.authCookie) message = message.split(config.authCookie).join('[REDACTED]');
    if (status === 500) runtime.log(null, 'error', error.message);
    res.status(status).json({ error: message });
  });
  return app;
}
