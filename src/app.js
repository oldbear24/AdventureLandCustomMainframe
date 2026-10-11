import express from 'express';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { MAX_SAVED_CHARACTERS, characterSchema, controlKeySchema, controlValueSchema, scriptSchema, settingsSchema } from './store.js';
import { Transfers, inventoryView, transferSchema } from './transfers.js';
import { aggregateItems, equipmentView, goldOf, itemsView, packsView } from './inventory.js';
import { STORAGE_KEY_LIMIT, storageView } from './runtime.js';
import { JOURNAL_TYPES } from './history.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const viewsDir = fileURLToPath(new URL('../views', import.meta.url));
// Each panel page is the shared shell (login, navigation, account dialog) around its own fragment.
const PAGES = {
  '/': ['overview', ''], '/automation': ['automation', 'Automatizace · '], '/map': ['map', 'Mapa · '], '/inventory': ['inventory', 'Inventáře · '], '/editor': ['editor', 'CODE editor · '], '/logs': ['logs', 'Logy · '],
  '/items': ['items', 'Předměty · '], '/stats': ['stats', 'Statistiky · '], '/journal': ['journal', 'Deník · '], '/monsters': ['monsters', 'Kde farmit · '], '/system': ['system', 'Systém · '], '/events': ['events', 'Události · '],
};
async function renderPage(page, title) {
  const [shell, fragment] = await Promise.all([readFile(path.join(viewsDir, 'shell.html'), 'utf8'), readFile(path.join(viewsDir, `${page}.html`), 'utf8')]);
  const [content, dialogs = ''] = fragment.split('<!-- dialogs -->');
  return shell.replace(`data-nav="${page}"`, `data-nav="${page}" aria-current="page"`)
    .replace('{{title}}', title).replaceAll('{{page}}', page).replace('{{content}}', () => content.trimEnd()).replace('{{dialogs}}', () => dialogs.trim());
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createApp(config, store, runtime, account = null, gameApi = null, gameData = null, system = null) {
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
      if (selected && selected.remoteSlot !== slot && runtime.usesScript(selected.id)) throw new HttpError(409, 'Před změnou CODE slotu zastav přiřazené postavy.');
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
  const storageKey = z.string().min(1).max(STORAGE_KEY_LIMIT);
  // Saves the edited value back; it must be valid JSON because CODE get() parses it.
  app.put('/api/characters/:id/storage/:key', async (req, res) => {
    const key = storageKey.parse(req.params.key);
    const { value } = z.object({ value: z.string().max(500_000) }).strict().parse(req.body);
    let parsed;
    try { parsed = JSON.parse(value); } catch { throw new HttpError(400, 'Hodnota musí být platný JSON (text v uvozovkách, číslo, true/false, null, pole nebo objekt).'); }
    await runtime.exclusive(() => runtime.setStorage(req.params.id, key, JSON.stringify(parsed)));
    res.json({ ok: true });
  });
  app.delete('/api/characters/:id/storage/:key', async (req, res) => {
    const key = storageKey.parse(req.params.key);
    res.json({ removed: await runtime.exclusive(() => runtime.setStorage(req.params.id, key, null)) });
  });
  app.delete('/api/characters/:id/storage', async (req, res) => res.json({ removed: await runtime.exclusive(() => runtime.clearStorage(req.params.id)) }));
  // Automation page: every character with what its CODE offers to set, what it reports doing and the remembered values.
  // Reads do not wait for the runtime queue (a reconnect can hold it for a minute); each one checks the session itself.
  app.get('/api/automation', async (_req, res) => {
    const characters = await Promise.all(store.snapshot().characters.map(async c => {
      const session = runtime.sessions.get(c.id);
      let live = null, error = null;
      if (session?.status === 'running') {
        try { live = await runtime.controls(c.id); } catch (failure) { error = runtime.redact(failure.message); }
      }
      return { id: c.id, name: c.name, status: session?.status || 'stopped', saved: c.controls || {}, pending: Object.keys(session?.pendingControls?.values || {}), live, error };
    }));
    res.json({ characters });
  });
  const characterExists = id => { if (!store.snapshot().characters.some(c => c.id === id)) throw new HttpError(404, 'Postava neexistuje.'); };
  const rememberControl = (id, key, value) => store.update(state => {
    const character = state.characters.find(c => c.id === id);
    if (!character) return;
    const controls = { ...character.controls };
    if (value === undefined) delete controls[key]; else controls[key] = value;
    if (Object.keys(controls).length) character.controls = controls; else delete character.controls;
  });
  // Sets one value in the running CODE; remember keeps it for the next connections, otherwise a remembered value is forgotten.
  app.put('/api/characters/:id/controls/:key', async (req, res) => {
    const key = controlKeySchema.parse(req.params.key);
    const { value, remember } = z.object({ value: controlValueSchema, remember: z.boolean().default(false) }).strict().parse(req.body);
    characterExists(req.params.id);
    const result = await runtime.setControl(req.params.id, key, value);
    if (!result.ok) throw new HttpError(422, result.message);
    // The CODE may normalise the value (e.g. an item's display name to its key); that form is remembered.
    await rememberControl(req.params.id, key, remember ? (controlValueSchema.safeParse(result.value).success ? result.value : value) : undefined);
    res.json({ ok: true, value: result.value, remembered: remember });
  });
  app.delete('/api/characters/:id/controls/:key', async (req, res) => {
    const key = controlKeySchema.parse(req.params.key);
    characterExists(req.params.id);
    const removed = Object.hasOwn(store.snapshot().characters.find(c => c.id === req.params.id).controls || {}, key);
    await rememberControl(req.params.id, key, undefined);
    const pending = runtime.sessions.get(req.params.id)?.pendingControls;
    if (pending) delete pending.values[key];
    res.json({ removed });
  });
  app.post('/api/characters/:id/command', async (req, res) => {
    const { command } = z.object({ command: z.string().trim().regex(/^\/?[a-zA-Z0-9_]{1,40}( [^\r\n]{0,200})?$/, 'Příkaz má tvar /název argumenty, např. /cil spidersilk 2.') }).strict().parse(req.body);
    characterExists(req.params.id);
    const [, name, args = ''] = command.match(/^\/?([a-zA-Z0-9_]{1,40})(?: +(.*))?$/);
    const result = await runtime.runCommand(req.params.id, name, args.trim());
    if (!result.ok) throw new HttpError(422, result.message);
    res.json({ ok: true });
  });
  // Item and monster keys with names, for the target fields on the Automation page.
  app.get('/api/targets', async (_req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(await gameData.targets());
  });
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
  app.get('/api/monsters', async (_req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(await gameData.monsters());
  });
  app.get('/api/item-sheets/:name', async (req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    const body = await gameData.sheet(req.params.name);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' }).send(body);
  });
  app.get('/api/sprite-sheets/:name', async (req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    const body = await gameData.spriteSheet(req.params.name);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400' }).send(body);
  });
  // Layers of a character sprite for a look (skin plus cx as place:id pairs), or the default look of a class.
  app.get('/api/character-sprites', async (req, res) => {
    if (!gameData) throw new HttpError(503, 'Herní data nejsou dostupná.');
    const query = z.object({
      skin: z.string().regex(/^[a-zA-Z0-9_]{1,40}$/).optional(), cx: z.string().regex(/^([a-z]{1,16}:[a-zA-Z0-9_]{1,40})(,[a-z]{1,16}:[a-zA-Z0-9_]{1,40}){0,15}$/).optional(),
      class: z.string().regex(/^[a-z]{1,24}$/).optional(),
    }).strict().parse(req.query);
    const cx = Object.fromEntries((query.cx ? query.cx.split(',') : []).map(pair => pair.split(':')));
    res.set('Cache-Control', 'private, max-age=86400');
    res.json(await gameData.characterSprite({ skin: query.skin, cx, ctype: query.class }));
  });
  const itemNames = async () => gameData ? gameData.itemNames() : {};
  // A running character is read live; any other owned character comes from the saved account snapshot.
  async function characterInventory(name, names) {
    const live = await runtime.exclusive(async () => {
      const session = runtime.sessionByName(name);
      return session ? runtime.details(session.id) : null;
    });
    if (live) {
      return { name: live.name, class: String(live.ctype || ''), level: goldOf(live.level), source: 'live', observedAt: new Date().toISOString(), gold: goldOf(live.gold), size: goldOf(live.isize) || live.items.length, items: itemsView(live.items, names), equipment: equipmentView(live.slots, names) };
    }
    if (!gameApi?.status().configured) throw new HttpError(409, 'Postava neběží v panelu. Pro uložený inventář připoj API token.');
    const profile = await gameApi.profile(name);
    const items = Array.isArray(profile.inventory) ? profile.inventory : [];
    return { name: typeof profile.name === 'string' ? profile.name : name, class: typeof profile.class === 'string' ? profile.class : '', level: goldOf(profile.level), source: 'saved', observedAt: typeof profile.synchronized_at === 'string' ? profile.synchronized_at : null, gold: goldOf(profile.gold), size: goldOf(profile.inventory_slots) || items.length, items: itemsView(items, names), equipment: equipmentView(profile.equipment, names) };
  }
  // The game only sends bank contents to a character standing in the bank; otherwise use the saved snapshot.
  async function bankContents(names) {
    const live = await runtime.exclusive(async () => {
      for (const session of runtime.sessions.values()) {
        if (session.status !== 'running' || !session.state?.map?.startsWith('bank')) continue;
        const details = await runtime.details(session.id).catch(() => null);
        if (details?.bank) return details;
      }
      return null;
    });
    if (live) return { source: 'live', observedAt: new Date().toISOString(), via: live.name, gold: goldOf(live.bank.gold), packs: packsView(live.bank, names) };
    if (!gameApi?.status().configured) throw new HttpError(409, 'Banka je živě vidět jen s postavou v bance. Pro uložený obsah připoj API token.');
    const bank = await gameApi.bank();
    return { source: 'saved', observedAt: typeof bank.observed_at === 'string' ? bank.observed_at : null, retrievedAt: typeof bank.retrieved_at === 'string' ? bank.retrieved_at : new Date().toISOString(), via: null, gold: goldOf(bank.gold), packs: packsView(bank.packs, names) };
  }
  app.get('/api/inventories/:name', async (req, res) => {
    const name = z.string().regex(/^[a-zA-Z0-9_]{1,32}$/).parse(req.params.name);
    res.json(await characterInventory(name, await itemNames()));
  });
  app.get('/api/bank', async (_req, res) => res.json(await bankContents(await itemNames())));
  // Every item of every character (panel and account) and the bank, grouped; kept for a minute because it costs many API reads.
  let itemsCache = null, itemsLoading = null;
  async function collectItems() {
    const names = await itemNames();
    const characters = new Map(store.snapshot().characters.map(c => [c.name.toLowerCase(), c.name]));
    if (gameApi?.status().configured) {
      const owned = await gameApi.characters().catch(() => ({ characters: [] }));
      for (const c of owned.characters) if (!characters.has(c.name.toLowerCase())) characters.set(c.name.toLowerCase(), c.name);
    }
    const sources = [];
    const failed = error => error.status && error.status < 500 ? error.message : runtime.redact(error.message || 'Načtení selhalo.');
    for (const name of [...characters.values()].sort((a, b) => a.localeCompare(b))) {
      try { sources.push({ kind: 'character', ...await characterInventory(name, names) }); }
      catch (error) { sources.push({ kind: 'character', name, error: failed(error) }); }
    }
    try { sources.push({ kind: 'bank', name: null, ...await bankContents(names) }); }
    catch (error) { sources.push({ kind: 'bank', name: null, error: failed(error) }); }
    return { generatedAt: new Date().toISOString(), ...aggregateItems(sources, names) };
  }
  app.get('/api/items', async (req, res) => {
    const age = itemsCache ? Date.now() - itemsCache.at : Infinity;
    // A manual refresh is honoured at most every 10 seconds.
    if (age < (req.query.refresh === '1' ? 10_000 : 60_000)) return res.json(itemsCache.body);
    itemsLoading ||= collectItems().then(body => { itemsCache = { at: Date.now(), body }; return body; }).finally(() => { itemsLoading = null; });
    res.json(await itemsLoading);
  });
  // CPU and memory of the panel, Chromium and the container, the data volume and per-character browser metrics.
  app.get('/api/system', async (_req, res) => {
    if (!system) throw new HttpError(503, 'Přehled systému není dostupný.');
    res.json(await system.report());
  });
  // The persistent journal, newest first; after polls for new entries, before pages back.
  app.get('/api/journal', (req, res) => {
    const id = z.coerce.number().int().min(0).optional();
    const query = z.object({
      types: z.string().max(200).optional().transform(value => value ? value.split(',').filter(Boolean) : null).pipe(z.array(z.enum(JOURNAL_TYPES)).nullable()),
      character: z.string().regex(/^[a-zA-Z0-9-]{1,64}$/).optional(), before: id, after: id, limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(req.query);
    const result = runtime.history ? runtime.history.query({ types: query.types, characterId: query.character ?? null, before: query.before ?? null, after: query.after ?? null, limit: query.limit }) : { entries: [], more: false };
    res.json({ ...result, available: !!runtime.history, types: JOURNAL_TYPES });
  });
  // Long-term XP/gold stats from the persistent samples. Buckets end at the next whole hour or day of the viewer's time zone.
  const RANGES = { '24h': [86_400_000, 3_600_000], '3d': [3 * 86_400_000, 6 * 3_600_000], '7d': [7 * 86_400_000, 86_400_000], '14d': [14 * 86_400_000, 86_400_000] };
  app.get('/api/history/stats', (req, res) => {
    const { range, offset } = z.object({ range: z.enum(Object.keys(RANGES)).default('24h'), offset: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const [span, bucket] = RANGES[range], now = Date.now(), shift = offset * 60_000;
    const to = Math.ceil((now + shift) / bucket) * bucket - shift, from = to - span;
    res.json({ now, range, from, to, bucketMs: bucket, available: !!runtime.history, characters: runtime.history ? runtime.history.stats(from, to, bucket) : [] });
  });
  // Bosses and server events seen by running characters, one reading per realm, and which of them notify.
  app.get('/api/server-events', async (_req, res) => {
    const catalog = gameData ? await gameData.eventCatalog().catch(() => []) : [];
    res.json({ now: Date.now(), realms: runtime.serverEvents(), catalog, notifyEvents: store.snapshot().settings.notifyEvents, notifications: runtime.notifier?.status() || { discord: false, telegram: false } });
  });
  app.put('/api/settings/notify-events', async (req, res) => {
    const { keys } = z.object({ keys: settingsSchema.shape.notifyEvents }).strict().parse(req.body);
    const saved = await store.update(state => { state.settings = { ...state.settings, notifyEvents: [...new Set(keys)].sort() }; return state.settings.notifyEvents; });
    res.json({ notifyEvents: saved });
  });
  app.post('/api/transfers/prepare', async (req, res) => res.json(await transfers.prepare(transferSchema.parse(req.body), sessionFor(req).token)));
  app.post('/api/transfers/:id/confirm', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(await transfers.confirm(z.uuid().parse(req.params.id), sessionFor(req).token));
  });
  // A panel with a live WebSocket receives logs there and asks for the dashboard without them (?logs=0).
  app.get('/api/dashboard', (req, res) => res.json({
    characters: store.snapshot().characters, looks: store.snapshot().looks, stands: store.snapshot().stands, scripts: store.snapshot().scripts.map(({ source, ...script }) => script),
    sessions: runtime.snapshot(), logs: req.query.logs === '0' ? undefined : runtime.logs,
    lastSeen: runtime.history?.lastSeen() || {},
    config: { authConfigured: !!config.authCookie, maxCharacters: config.maxCharacters, maxSaved: MAX_SAVED_CHARACTERS, notifications: runtime.notifier?.status() || { discord: false, telegram: false } },
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
  // Start, stop, reload CODE, relog or move several characters at once; each character reports its own result.
  const batchSchema = z.object({
    action: z.enum(['start', 'stop', 'reload', 'relog', 'move']), ids: z.array(z.uuid()).max(MAX_SAVED_CHARACTERS).optional(),
    region: characterSchema.shape.region.optional(), server: characterSchema.shape.server.optional(),
  }).strict().refine(input => input.action !== 'move' || (input.region && input.server), 'Přesun vyžaduje region a server.');
  app.post('/api/characters/batch', async (req, res) => {
    const input = batchSchema.parse(req.body);
    const targets = store.snapshot().characters.filter(c => !input.ids || input.ids.includes(c.id));
    if (!targets.length) throw new HttpError(400, 'Žádná postava k provedení akce.');
    const results = [];
    const report = (character, error = null, skipped = false, note = null) => results.push({ id: character.id, name: character.name, ok: !error, skipped, note, error: error ? runtime.redact(error.message || error) : null });
    const startAll = async list => {
      for (const character of list) {
        try { await runtime.start(character.id); report(character); } catch (error) { report(character, error); }
      }
    };
    if (input.action === 'start') {
      const idle = targets.filter(c => !runtime.sessions.has(c.id));
      for (const character of targets.filter(c => runtime.sessions.has(c.id))) report(character, null, true);
      // Characters start in the list's order until every place for a running character is taken.
      for (const character of idle) {
        if (runtime.sessions.size >= config.maxCharacters) { report(character, null, true, 'není volné místo'); continue; }
        try { await runtime.start(character.id); report(character); } catch (error) { report(character, error); }
      }
    } else if (input.action === 'stop') {
      await runtime.exclusive(async () => {
        const ids = new Set(targets.map(c => c.id));
        await store.update(state => { for (const c of state.characters) if (ids.has(c.id)) c.autoStart = false; });
        for (const character of targets) { await runtime.stopInternal(character.id); report(character); }
      });
    } else if (input.action === 'reload') {
      // Only connected characters run CODE; the rest are skipped.
      for (const character of targets) {
        if (runtime.sessions.get(character.id)?.status !== 'running') { report(character, null, true); continue; }
        try { await runtime.reload(character.id); report(character); } catch (error) { report(character, error); }
      }
    } else if (input.action === 'relog') {
      // Active characters are stopped and logged in again; autostart is kept.
      const active = await runtime.exclusive(async () => {
        const list = targets.filter(c => runtime.sessions.has(c.id));
        for (const character of list) await runtime.stopInternal(character.id);
        return list;
      });
      for (const character of targets.filter(c => !active.includes(c))) report(character, null, true);
      await startAll(active);
    } else {
      // Running characters are stopped, moved and started again; autostart is kept.
      const running = await runtime.exclusive(async () => {
        const active = targets.filter(c => runtime.sessions.has(c.id));
        for (const character of active) await runtime.stopInternal(character.id);
        const ids = new Set(targets.map(c => c.id));
        await store.update(state => { for (const c of state.characters) if (ids.has(c.id)) { c.region = input.region; c.server = input.server; } });
        for (const character of targets) if (character.region !== input.region || character.server !== input.server) runtime.journal(character.id, 'move', `Přesun z ${character.region} ${character.server} na ${input.region} ${input.server}.`);
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
      if (state.characters.length >= MAX_SAVED_CHARACTERS) throw new HttpError(409, `Panel uloží nejvýš ${MAX_SAVED_CHARACTERS} postav.`);
      if (state.characters.some(c => c.name.toLowerCase() === input.name.toLowerCase())) throw new HttpError(409, 'Postava už je přidaná.');
      if (input.scriptId && !state.scripts.some(s => s.id === input.scriptId)) throw new HttpError(400, 'Skript neexistuje.');
      const result = { ...input, id: randomUUID() }; state.characters.push(result); return result;
    });
    res.status(201).json(character);
  });
  // The order of the list decides which characters autostart and Start all take first.
  app.put('/api/characters/order', async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.uuid()).max(MAX_SAVED_CHARACTERS) }).strict().parse(req.body);
    await store.update(state => {
      const current = new Map(state.characters.map(c => [c.id, c]));
      if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some(id => !current.has(id))) throw new HttpError(409, 'Seznam postav se mezitím změnil. Načti panel znovu.');
      state.characters = ids.map(id => current.get(id));
    });
    res.json({ ok: true });
  });
  // Starts a stopped character in place of a running one; the replaced character's autostart is turned off like with Stop.
  app.post('/api/characters/:id/swap', async (req, res) => {
    const { replace } = z.object({ replace: z.uuid() }).strict().parse(req.body);
    await runtime.swap(req.params.id, replace);
    await store.update(state => { const c = state.characters.find(c => c.id === replace); if (c) c.autoStart = false; });
    res.json({ ok: true });
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
        // Remembered Automation values are not part of the form and stay with the character.
        const { controls } = state.characters[index];
        state.characters[index] = { ...input, id: req.params.id, ...(controls ? { controls } : {}) };
      });
    });
    res.json({ ok: true });
  });
  app.delete('/api/characters/:id', async (req, res) => {
    await runtime.exclusive(async () => {
      await runtime.stopInternal(req.params.id); runtime.forget(req.params.id);
      await store.update(state => { state.characters = state.characters.filter(c => c.id !== req.params.id); delete state.looks[req.params.id]; delete state.stands[req.params.id]; });
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
    await runtime.exclusive(() => store.update(state => {
      if (state.characters.some(c => c.scriptId === req.params.id)) throw new HttpError(409, 'Skript je přiřazen postavě. Nejdřív změň přiřazení.');
      // Characters with automatic CODE run their default slot without having it assigned.
      if (runtime.usesScript(req.params.id)) throw new HttpError(409, 'Skript právě používá běžící postava jako výchozí CODE. Nejdřív ji zastav.');
      state.scripts = state.scripts.filter(s => s.id !== req.params.id);
    })); res.json({ ok: true });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint neexistuje.' }));
  for (const [route, [page, title]] of Object.entries(PAGES)) app.get(route, async (_req, res) => res.type('html').set('Cache-Control', 'no-cache').send(await renderPage(page, title)));
  app.use(express.static(publicDir, { index: false }));
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
