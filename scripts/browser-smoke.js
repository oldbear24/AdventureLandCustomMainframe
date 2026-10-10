// End-to-end validation against an entirely local game fixture. Never logs into Adventure Land.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { Runtime, GAME_ORIGIN } from '../src/runtime.js';
import { createApp } from '../src/app.js';
import { createWebServer } from '../src/server.js';
import { configFromEnv } from '../src/config.js';
import { GameAccount } from '../src/game-account.js';
import { GameApi } from '../src/game-api.js';
import { GameData } from '../src/game-data.js';
import { attachLive } from '../src/live.js';
import { History } from '../src/history.js';

const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-browser-'));
const config = configFromEnv({ ADMIN_PASSWORD: 'test-password-is-long-enough', DATA_DIR: directory });
const store = new Store(directory); await store.init();
let alreadyOnline = false, accountValid = true, owned = true, crashed = false;
const navigations = [];
const browserType = {
  async launch(options) {
    const browser = await chromium.launch(options);
    const original = browser.newContext.bind(browser);
    browser.newContext = async contextOptions => {
      const context = await original(contextOptions);
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== GAME_ORIGIN) return route.abort();
        navigations.push(url.pathname);
        assert.match(route.request().headers().cookie || '', /auth=fixture-user-fixture-auth-secret/);
        const body = url.pathname.startsWith('/server/') ? `<script>window.user_id=${JSON.stringify(accountValid ? 'fixture-user' : '')}; window.X={characters:${JSON.stringify(owned ? [{ name: 'TestWarrior', online: alreadyOnline }] : [])},servers:[{region:'EU',name:'I'}]};</script>` : url.pathname.startsWith('/character/') ? `<!doctype html><body><script>
          window.character={name:'TestWarrior',ctype:'warrior',level:42,hp:1600,max_hp:2000,mp:320,max_mp:500,xp:5000,max_xp:20000,gold:1234567,items:[{name:'hpot0',q:10},{name:'sword',level:3,l:'l'}],slots:{mainhand:{name:'sword',level:5},helmet:null},map:'main',x:20,y:40,isize:42,party:'TestWarrior',s:{cursed:{ms:5000},mluck:{ms:60000,f:'Merchant'}}};window.sentTransfers=[];
          window.G={conditions:{cursed:{name:'Cursed',debuff:true},mluck:{name:"Merchant's Luck",buff:true}},skills:{supershot:{name:'Super Shot',cooldown:30000},attack:{name:'Attack'}}};
          window.next_skill={attack:new Date(Date.now()+400),supershot:new Date(Date.now()+20000)};
          window.party={TestWarrior:{type:'warrior',level:42,map:'main',x:20,y:40},Healer:{type:'priest',level:40,map:'main',x:50,y:80}};
          window.entities={m1:{type:'monster',mtype:'goo',map:'main',x:60,y:40,target:'TestWarrior'},p1:{type:'character',name:'Stranger',map:'main',x:-30,y:10}};
          window.S={franky:{live:true,hp:60000,max_hp:120000,map:'main',x:10,y:20,target:'TestWarrior'},icegolem:{live:false,spawn:new Date(Date.now()+3600000).toISOString()},halloween:true};
          window.socket={connected:true};window.code_run=false;window.code_active=false;
          window.add_log=()=>{};window.add_codelog=()=>{};
          window.stop_runner=()=>{document.querySelector('#maincode')?.remove();window.code_run=window.code_active=false};
          window.start_runner=(id,source)=>{window.the_code=source;window.code_run=true;const f=document.createElement('iframe');f.id=id;f.src='/runner';document.body.appendChild(f)};
        </script>` : url.pathname === '/runner' ? `<!doctype html><body><script>parent.code_active=true;window.character=parent.character;window.game_log=parent.add_codelog;window.send_gold=async(name,gold)=>{parent.sentTransfers.push({name,gold});character.gold-=gold;return {response:'gold_sent',name,gold}};window.send_item=async(name,num,q)=>{const item=character.items[num];parent.sentTransfers.push({name,num,q});item.q-=q;return {response:'item_sent',name,num,q,item:item.name}};const s=document.createElement('script');s.textContent=parent.the_code;document.body.appendChild(s);</script>` : '<!doctype html><body>fixture</body>';
        await route.fulfill({ contentType: 'text/html', body });
      });
      return context;
    };
    return browser;
  },
};
const runtime = new Runtime(config, store, browserType);
runtime.history = new History(directory); await runtime.history.init();
// A day of five-minute samples for two former characters, with an hour offline, for the stats page.
{
  const now = Date.now();
  for (const [id, name, rate] of [['seed-alpha', 'Alpha', 900], ['seed-beta', 'Beta', 400]]) {
    const points = [];
    for (let i = 288; i >= 1; i--) if (name !== 'Beta' || i < 100 || i > 112) points.push([now - i * 300_000, 40, (288 - i) * rate, 400_000, 1000 + (288 - i) * 7]);
    runtime.history.samples.set(id, { name, points });
  }
  runtime.history.journal.push({ id: 1, at: now - 3_600_000, type: 'death', characterId: 'seed-beta', name: 'Beta', message: 'Postava zemřela.', realm: null });
  runtime.history.nextId = 2;
}
const account = new GameAccount(config, runtime, async (url, options) => {
  assert.equal(url, `${GAME_ORIGIN}/api/signup_or_login`);
  assert.equal(JSON.parse(options.body).only_login, true);
  if (JSON.parse(options.body).password !== 'fixture-game-password') return new Response(JSON.stringify({ failed: true, reason: 'wrong_password' }), { status: 401 });
  return new Response(JSON.stringify({ success: true, user: 'fixture-user', auth: 'fixture-auth-secret' }), { status: 200 });
}); await account.init();
let cloudCode = { slot: '1', name: 'Fixture warrior', version: 1, code: 'game_log("fixture CODE ready"); console.log("browser bridge verified");' };
let apiAvailable = true;
const gameApi = new GameApi(config, async (url, options) => {
  const input = JSON.parse(options.body);
  assert.equal(input.token, `mcp_${'a'.repeat(43)}`);
  if (!apiAvailable) throw new Error('Fixture API offline');
  const method = url.slice(url.lastIndexOf('/') + 1);
  assert.ok(url.startsWith(`${GAME_ORIGIN}/mcp_api/`));
  if (method === 'mainframe_list_characters') return Response.json({ success: true, characters: [{ character: 'TestWarrior', level: 42, class: 'warrior', profile: { online: false } }, { character: 'SavedMage', level: 30, class: 'mage', profile: { online: false, map: 'main', x: -60, y: -20 } }] });
  if (method === 'mainframe_get_character') return Response.json({ success: true, profile: { name: 'SavedMage', class: 'mage', level: 30, gold: 77, inventory_slots: 42, synchronized_at: '2026-10-10T01:00:00.000Z', inventory: [{ name: 'hpot0', q: 5 }], equipment: { mainhand: { name: 'staff', level: 2 } } } });
  if (method === 'get_bank') return Response.json({ success: true, gold: 465870, retrieved_at: new Date().toISOString(), packs: { items0: [{ name: 'hpot0', q: 131 }, null, { name: 'sword', level: 4 }] } });
  if (method === 'list_codes') return Response.json({ success: true, codes: [{ slot: cloudCode.slot, name: cloudCode.name, version: cloudCode.version }] });
  assert.equal(input.slot, '1');
  if (method === 'get_code') return Response.json({ success: true, code: { ...cloudCode } });
  if (method === 'save_code') { cloudCode = { ...cloudCode, name: input.name, code: input.code, version: cloudCode.version + 1 }; return Response.json({ success: true, code: { slot: '1', name: cloudCode.name, version: cloudCode.version } }); }
  throw new Error(`Unexpected API method ${method}`);
}); await gameApi.init();
runtime.gameApi = gameApi;
// A 40×40 RGB sheet of 2×2 solid tiles stands in for the game's item icons.
function iconSheet() {
  const chunk = (type, data) => { const head = Buffer.alloc(8), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); head.write(type, 4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data]))); return Buffer.concat([head, data, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(40, 0); header.writeUInt32BE(40, 4); header[8] = 8; header[9] = 2;
  const rows = []; for (let y = 0; y < 40; y++) { rows.push(0); for (let x = 0; x < 40; x++) rows.push(x < 20 ? 200 : 40, y < 20 ? 60 : 180, 90); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const fixtureData = { version: 1, events: { franky: { name: 'Franky' }, halloween: { name: 'Halloween' } }, items: { hpot0: { name: 'Health Potion' }, sword: { name: 'Short Sword', type: 'weapon', attack: 20, upgrade: { attack: 5 }, explanation: 'A trusty blade.' } }, npcs: {}, monsters: { goo: { name: 'Goo' }, franky: { name: 'Franky' }, icegolem: { name: 'Ice Golem' } },
  imagesets: { pack_20: { size: 20, rows: 2, columns: 2, file: '/images/tiles/items/pack_20vt8.png' } }, positions: { hpot0: ['', 1, 0] },
  maps: { main: { key: 'main', name: 'Mainland', npcs: [{ id: 'merchant', name: 'Merchant', position: [0, -60] }], doors: [[150, 100, 24, 30, 'bank']], monsters: [{ type: 'goo', boundary: [40, 0, 140, 90], count: 3 }] }, bank: { key: 'bank', name: 'The Bank', npcs: [], doors: [], monsters: [] } },
  geometry: { main: { min_x: -200, max_x: 200, min_y: -120, max_y: 160, x_lines: [[-200, -120, 160], [200, -120, 160]], y_lines: [[-120, -200, 200], [160, -200, 200]] }, bank: { min_x: -50, max_x: 50, min_y: -50, max_y: 50, x_lines: [], y_lines: [] } } };
const gameData = new GameData(async url => {
  if (url === `${GAME_ORIGIN}/images/tiles/items/pack_20vt8.png`) return new Response(iconSheet());
  assert.equal(url, `${GAME_ORIGIN}/data.js`); return new Response(`var G=${JSON.stringify(fixtureData)};`);
});
const app = createApp(config, store, runtime, account, gameApi, gameData);
const server = await createWebServer(config, app); const live = attachLive(server, app, runtime); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `https://127.0.0.1:${server.address().port}`;
await mkdir('test-results', { recursive: true });
let uiBrowser;
try {
  uiBrowser = await chromium.launch({ headless: true });
  // The generated certificate is self-signed; Chromium would otherwise show its interstitial.
  const page = await uiBrowser.newPage({ viewport: { width: 1440, height: 1100 }, ignoreHTTPSErrors: true });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  await page.goto(origin);
  await page.locator('#password').fill(config.password);
  await page.locator('#login-form button').click();
  await page.locator('#panel').waitFor({ state: 'visible' });
  assert.match(await page.locator('#characters').textContent(), /Tvůj tým/);
  await page.locator('#manage-account').click();
  await page.locator('#game-email').fill('fixture@example.com');
  await page.locator('#game-password').fill('wrong-game-password');
  await page.locator('#game-login-form button').click();
  await page.waitForFunction(() => document.getElementById('game-account-error').textContent.includes('selhalo'));
  assert.equal(await page.locator('#panel').isVisible(), true);
  assert.equal(await page.locator('#game-password').inputValue(), '');
  await page.locator('#game-password').fill('fixture-game-password');
  await page.locator('#game-login-form button').click();
  await page.locator('#account-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#account-status').textContent(), /fixture@example.com/);
  assert.equal(await page.locator('#game-password').inputValue(), '');
  await page.locator('#manage-account').click();
  await page.locator('summary').filter({ hasText: 'API token' }).click();
  await page.locator('#api-token').fill(`mcp_${'a'.repeat(43)}`);
  await page.locator('#api-token-form button').click();
  await page.locator('#account-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#api-token').inputValue(), '');
  assert.match(await page.locator('#owned-characters').textContent(), /TestWarrior/);
  await page.locator('[data-nav=editor]').click();
  await page.locator('#load-code-slots').click();
  await page.locator('#import-code-slot').click();
  await page.waitForFunction(() => document.querySelectorAll('.script-item').length === 1);
  assert.match(await page.locator('#editing-name').textContent(), /Fixture warrior/);
  assert.match(await page.locator('#editing-meta').textContent(), /Herní slot 1/);
  await page.locator('[data-nav=overview]').click();
  await page.locator('[data-owned-index="0"]').click();
  assert.equal(await page.locator('#character-name').inputValue(), 'TestWarrior');
  await page.locator('#character-script').selectOption({ label: 'Fixture warrior · slot 1' });
  await page.locator('#character-form button[type=submit]').click();
  await page.locator('.character-card').waitFor();
  await page.locator('[data-action=start]').click();
  await page.waitForFunction(() => document.querySelector('.badge')?.textContent === 'ONLINE');
  await runtime.tick();
  const session = runtime.snapshot()[0];
  assert.equal(session.status, 'running'); assert.equal(session.state.level, 42); assert.equal(session.state.codeRunning, true);
  assert.ok(runtime.logs.some(l => l.message.includes('fixture CODE ready')));
  await page.reload(); await page.locator('#panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#stat-gold').textContent !== '—');
  await page.locator('#load-owned').click();
  await page.waitForFunction(() => document.querySelector('#owned-characters').textContent.includes('V panelu'));
  const gamePage = runtime.sessions.values().next().value.page;
  assert.equal(await gamePage.evaluate(() => window.the_code), cloudCode.code);
  await page.locator('[data-action=transfer]').click();
  await page.locator('#transfer-to').fill('Receiver'); await page.locator('#transfer-amount').fill('200');
  await page.locator('#transfer-form button').click(); await page.locator('#transfer-review').waitFor({ state: 'visible' });
  assert.match(await page.locator('#transfer-summary').textContent(), /TestWarrior → Receiver: 200 G/);
  assert.equal(await gamePage.evaluate(() => window.sentTransfers.length), 0);
  await page.locator('#confirm-transfer').click();
  await page.waitForFunction(() => document.getElementById('transfer-result').textContent.includes('potvrdil'));
  assert.equal(await gamePage.evaluate(() => window.sentTransfers.length), 1);
  await page.locator('#close-transfer').click();
  await page.locator('[data-action=transfer]').click();
  await page.locator('#transfer-to').fill('Receiver'); await page.locator('#transfer-type').selectOption('item');
  assert.equal(await page.locator('#transfer-item option').count(), 1); // Locked sword is excluded.
  await page.locator('#transfer-quantity').fill('3'); await page.locator('#transfer-form button').click();
  await page.locator('#transfer-review').waitFor({ state: 'visible' }); await page.locator('#confirm-transfer').click();
  await page.waitForFunction(() => document.getElementById('transfer-result').textContent.includes('potvrdil'));
  assert.equal(await gamePage.evaluate(() => window.character.items[0].q), 7);
  await page.locator('#close-transfer').click();
  await page.locator('[data-action=transfer]').click();
  await page.locator('#transfer-to').fill('Receiver'); await page.locator('#transfer-type').selectOption('item');
  await page.locator('#transfer-form button').click(); await page.locator('#transfer-review').waitFor({ state: 'visible' });
  await gamePage.evaluate(() => { window.character.items[0].q = 6; });
  await page.locator('#confirm-transfer').click();
  await page.waitForFunction(() => document.getElementById('transfer-result').textContent.includes('Inventář se změnil'));
  assert.equal(await gamePage.evaluate(() => window.sentTransfers.length), 2);
  await page.locator('#close-transfer').click();
  // An edit saved in the game's browser slot becomes the source for the local runner.
  cloudCode = { ...cloudCode, code: 'game_log("saved in game browser");', version: cloudCode.version + 1 };
  runtime.nextCodeSync = 0; await runtime.exclusive(() => runtime.tick());
  assert.equal(await gamePage.evaluate(() => window.the_code), cloudCode.code);
  apiAvailable = false; runtime.nextCodeSync = 0; await runtime.exclusive(() => runtime.tick());
  assert.equal(await gamePage.evaluate(() => window.code_active), false);
  assert.match(runtime.snapshot()[0].code.error, /pozastaven/);
  apiAvailable = true; runtime.nextCodeSync = 0; await runtime.exclusive(() => runtime.tick());
  assert.equal(await gamePage.evaluate(() => window.code_active), true);
  assert.equal(await gamePage.evaluate(() => window.the_code), cloudCode.code);
  assert.equal(await page.locator('.meter i').first().evaluate(element => Math.round(element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width * 100)), 80);
  // Telemetry: XP bar, effects, supplies, party overview, skill cooldowns and the potion alert (no MP potions).
  await runtime.exclusive(() => runtime.tick());
  await page.waitForFunction(() => document.querySelector('.meter.xp') && document.querySelector('.card-alerts .alert-potions') && document.querySelector('#party-panel:not([hidden]) .party-table'));
  assert.match(await page.locator('.condition.debuff').textContent(), /Cursed/);
  assert.match(await page.locator('.condition.buff').textContent(), /Merchant's Luck/);
  assert.match(await page.locator('.supplies').textContent(), /HP 10 · MP 0/);
  assert.match(await page.locator('#party-body').textContent(), /Healer.*priest.*EU I/s);
  assert.match(await page.evaluate(() => document.title), /^\(1\) /);
  assert.equal(await page.locator('.character-card.has-alert').count(), 1);
  await page.locator('.card-more summary').click();
  assert.match(await page.locator('.skill-list').textContent(), /Super Shot/);
  const updated = await page.locator('#last-update').textContent();
  await page.waitForFunction(previous => document.querySelector('#last-update').textContent !== previous, updated);
  assert.equal(await page.locator('.card-more[open]').count(), 1, 'opened cooldowns survive the 5 s refresh');
  await page.locator('#move-all').click();
  assert.equal(await page.locator('#move-characters input:checked').count(), 1);
  await page.locator('#close-move').click();
  assert.equal(await page.locator('#start-all').isDisabled(), true);
  // Live map: own character, nearby monster/player, saved position of another character, doors switch maps.
  await runtime.exclusive(() => runtime.tick());
  // The card's map link opens the map page following the character.
  await page.locator('.character-card a[href^="/map?follow="]').click();
  const mapScene = () => page.evaluate(() => document.getElementById('map-canvas').scene);
  await page.waitForFunction(() => { const scene = document.getElementById('map-canvas').scene; return scene?.own.length && scene.saved.length && scene.nearby.some(e => e.kind === 'monster' && e.target); });
  assert.match(await page.locator('#map-name').textContent(), /Mainland/);
  let scene = await mapScene();
  assert.equal(scene.nearby.filter(e => e.kind === 'character').length, 1);
  assert.equal(scene.own[0].ring, 'debuff'); assert.equal(scene.own[0].name, 'TestWarrior');
  assert.equal(scene.saved[0].name, 'SavedMage');
  await page.waitForFunction(() => /TestWarrior.*Cursed.*SavedMage/s.test(document.querySelector('#map-characters').textContent));
  await page.waitForFunction(() => document.querySelector('#map-nearby').textContent.includes('goo'));
  await page.locator('#map-follow').selectOption('');
  await page.locator('#map-characters [data-follow]').click();
  assert.equal(await page.locator('#map-follow').inputValue(), store.snapshot().characters[0].id);
  assert.match(page.url(), /\/map\?follow=/);
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.screenshot({ path: 'test-results/map-desktop.png', fullPage: true });
  // Real time: a move in the game page reaches the map over the WebSocket without a dashboard tick.
  await page.waitForFunction(() => document.querySelector('#map-status').textContent.includes('WebSocket'));
  await gamePage.evaluate(() => { window.character.x = 137; window.character.y = -41; });
  await page.waitForFunction(() => document.getElementById('map-canvas').scene.own[0]?.x === 137, null, { timeout: 3000 });
  scene = await mapScene(); assert.equal(scene.own[0].y, -41);
  // Clicking a door drawn on the canvas switches to the neighbouring map.
  await page.locator('#map-fit').click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const door = await page.waitForFunction(() => document.getElementById('map-canvas').hits?.find(h => h.type === 'door' && h.to === 'bank')).then(handle => handle.jsonValue());
  const canvasBox = await page.locator('#map-canvas').boundingBox();
  await page.mouse.click(canvasBox.x + door.x + door.w / 2, canvasBox.y + door.y + door.h / 2);
  await page.waitForFunction(() => document.querySelector('#map-name').textContent === 'The Bank');
  assert.match(page.url(), /\/map\?map=bank/);
  await page.locator('#map-picker').selectOption('main');
  await page.locator('#map-doors [data-door=bank]').click();
  await page.waitForFunction(() => document.querySelector('#map-name').textContent === 'The Bank');
  // Logs arrive over the same WebSocket; the dashboard poll leaves them out while it is connected.
  // Old single-page addresses lead to the new pages.
  await page.goto(`${origin}/#logs`); await page.waitForURL(`${origin}/logs`);
  await page.waitForFunction(() => document.querySelector('#logs-mode').textContent.includes('WebSocket'));
  await page.goto(`${origin}/logs?character=${store.snapshot().characters[0].id}`);
  await page.waitForFunction(() => document.querySelector('#logs-mode').textContent.includes('WebSocket'));
  assert.equal(await page.locator('#log-filter').inputValue(), store.snapshot().characters[0].id);
  await gamePage.evaluate(() => console.log('live log line'));
  await page.waitForFunction(() => document.querySelector('#logs').textContent.includes('live log line'), null, { timeout: 3000 });
  // Stats: long-term XP and gold from the persistent samples, with hover readouts and a summary table.
  await page.locator('[data-nav=stats]').click();
  await page.waitForFunction(() => document.querySelector('#stats-table tbody'));
  assert.match(await page.locator('#stats-table tr[data-character=seed-beta]').textContent(), /^Beta40/);
  assert.equal(await page.locator('#chart-xp path.line').count(), await page.locator('#stats-table tbody tr').count());
  // Beta was offline for an hour: its line has two segments; Alpha ran the whole day.
  assert.equal((await page.locator('#chart-xp path.line[data-series=Beta]').getAttribute('d')).split('M').length - 1, 2);
  assert.equal((await page.locator('#chart-xp path.line[data-series=Alpha]').getAttribute('d')).split('M').length - 1, 1);
  const xpBox = await page.locator('#chart-xp .hit').boundingBox();
  await page.mouse.move(xpBox.x + xpBox.width * 0.5, xpBox.y + 40);
  await page.waitForFunction(() => !document.getElementById('chart-tip').hidden);
  assert.match(await page.locator('#chart-tip').textContent(), /XP.*Alpha/s);
  const column = await page.locator('#chart-bars .column').last().boundingBox();
  await page.mouse.move(column.x + column.width / 2, column.y + column.height - 3);
  await page.waitForFunction(() => document.getElementById('chart-tip').textContent.includes('celkem'));
  await page.screenshot({ path: 'test-results/stats-desktop.png', fullPage: true });
  await page.locator('[data-range="7d"]').click();
  await page.waitForFunction(() => document.getElementById('chart-bars-title').textContent === 'XP za den');
  assert.match(page.url(), /range=7d/);
  await page.setViewportSize({ width: 390, height: 844 });
  // Charts are drawn again for the new width once resizing settles.
  await page.waitForFunction(() => Number(document.querySelector('#chart-xp svg').getAttribute('width')) < 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: 'test-results/stats-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Journal: the persistent timeline, filtered by type and character.
  await page.locator('[data-nav=journal]').click();
  await page.waitForFunction(() => document.querySelectorAll('.journal-entry').length > 3);
  const journal = await page.locator('#journal-list').textContent();
  assert.match(journal, /Dnes/); assert.match(journal, /Start.*TestWarrior.*Spuštěno na EU I/s); assert.match(journal, /Připojeno/); assert.match(journal, /CODE Fixture warrior/);
  assert.match(journal, /Upozornění.*TestWarrior.*Docházejí lektvary/s);
  await page.locator('#journal-types [data-type=death]').click();
  await page.waitForFunction(() => document.querySelectorAll('.journal-entry').length === 1);
  assert.match(await page.locator('.journal-entry').textContent(), /Smrt.*Beta.*zemřela/s);
  assert.match(page.url(), /type=death/);
  await page.locator('#journal-types [data-type=""]').click();
  await page.locator('#journal-character').selectOption({ label: 'TestWarrior' });
  await page.waitForFunction(() => [...document.querySelectorAll('.journal-entry .journal-who')].every(e => e.textContent === 'TestWarrior'));
  // A new entry appears with the next dashboard refresh.
  runtime.journal(store.snapshot().characters[0].id, 'level', 'Dosažen level 43.');
  await page.waitForFunction(() => document.querySelector('.journal-entry').textContent.includes('level 43'), null, { timeout: 8000 });
  await page.screenshot({ path: 'test-results/journal-desktop.png', fullPage: true });
  // Events: the server's bosses and events as the running character's game client sees them.
  await page.locator('[data-nav=events]').click();
  await page.waitForFunction(() => document.querySelector('[data-realm="EU I"] [data-event=franky]'));
  assert.match(await page.locator('[data-event=franky]').textContent(), /ŽIVĚ.*60\s000 \/ 120\s000.*Mainland.*TestWarrior/s);
  assert.match(await page.locator('[data-event=icegolem]').textContent(), /Ice Golem.*ČEKÁ.*Objeví se za (59|60) min/s);
  assert.match(await page.locator('[data-event=halloween]').textContent(), /SEZÓNNÍ/);
  await page.locator('[data-notify-event=franky]').check();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('uložena'));
  assert.deepEqual(store.snapshot().settings.notifyEvents, ['franky']);
  await page.screenshot({ path: 'test-results/events-desktop.png', fullPage: true });
  // Inventories: running character live, other account character and bank from the saved snapshot.
  await page.locator('[data-nav=inventory]').click();
  await page.locator('[data-inventory=TestWarrior]').click();
  await page.waitForFunction(() => document.querySelector('#inventory-detail').textContent.includes('Health Potion'));
  assert.match(await page.locator('#inventory-detail').textContent(), /Živě/);
  assert.match(await page.locator('#inventory-detail').textContent(), /Short Sword/);
  // Health Potion has a game icon, Short Sword falls back to a placeholder; the sheet loads under the panel CSP.
  assert.equal(await page.locator('#inventory-detail .item-icon:not(.missing)').count(), 1);
  assert.match(await page.locator('#inventory-detail .item-icon:not(.missing)').getAttribute('style'), /item-sheets\/pack_20.*background-position:-32px 0px/);
  assert.equal(await page.evaluate(() => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth); image.onerror = () => resolve(0); image.src = '/api/item-sheets/pack_20'; })), 40);
  // Clicking an item shows its description and stats computed from the game data (+5 sword: 20 + 5·5 attack).
  await page.locator('#inventory-detail .item-grid.equipment .item-tile[role=button]').first().click();
  await page.waitForFunction(() => document.querySelector('#item-dialog').open);
  assert.match(await page.locator('#item-detail').textContent(), /Short Sword \+5/);
  assert.match(await page.locator('#item-detail').textContent(), /A trusty blade\./);
  assert.match(await page.locator('#item-detail .item-stats').textContent(), /Poškození45/);
  await page.locator('#close-item').click();
  await page.locator('#inventory-filter').fill('potion');
  assert.equal(await page.locator('#inventory-detail .item-tile:not(.dimmed):not(.empty-slot)').count(), 1);
  await page.locator('#inventory-filter').fill('');
  await page.locator('[data-inventory=SavedMage]').click();
  await page.waitForFunction(() => document.querySelector('#inventory-detail').textContent.includes('Uložený stav'));
  await page.locator('[data-inventory=__bank__]').click();
  await page.waitForFunction(() => document.querySelector('#inventory-detail').textContent.includes('Trezor 1'));
  assert.match(await page.locator('#inventory-detail').textContent(), /465\s870 G/);
  await page.screenshot({ path: 'test-results/bank-desktop.png', fullPage: true });
  // Items across the account: live character, saved character and bank in one table.
  await page.locator('[data-nav=items]').click();
  await page.waitForFunction(() => document.querySelector('#items-table tbody'));
  assert.match(await page.locator('tr[data-item="hpot0||"]').textContent(), /Health Potion.*142.*SavedMage · inventář ×5.*TestWarrior · inventář ×6.*Banka ×131/s);
  await page.locator('#items-owner').selectOption('__bank__');
  assert.match(page.url(), /owner=__bank__/);
  assert.match(await page.locator('tr[data-item="hpot0||"]').textContent(), /131/);
  assert.equal(await page.locator('tr[data-item="sword|5|"]').count(), 0, 'the equipped sword is not in the bank');
  await page.locator('#items-owner').selectOption('');
  await page.locator('#items-place').selectOption('equipment');
  assert.equal(await page.locator('#items-table tbody tr').count(), 2);
  await page.locator('#items-search').fill('sword');
  assert.equal(await page.locator('#items-table tbody tr').count(), 1);
  await page.screenshot({ path: 'test-results/items-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: 'test-results/bank-mobile.png', fullPage: true });
  await page.locator('[data-nav=map]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: 'test-results/map-mobile.png', fullPage: true });
  // Values saved by CODE set() live in the game page's localStorage under "cstore_".
  await gamePage.evaluate(() => { localStorage.setItem('cstore_farm_state', JSON.stringify({ map: 'main', kills: 12 })); localStorage.setItem('cstore_leader', '"TestWarrior"'); localStorage.setItem('game_setting', 'hidden'); });
  await page.locator('[data-nav=overview]').click();
  await page.locator('[data-action=storage]').click();
  await page.locator('#storage-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.storage-entry').count(), 2);
  assert.match(await page.locator('#storage-list').textContent(), /farm_state[\s\S]*"kills": 12/);
  assert.doesNotMatch(await page.locator('#storage-list').textContent(), /game_setting/);
  assert.match(await page.locator('#storage-from').textContent(), /TestWarrior · 2 hodnoty/);
  await page.locator('#storage-filter').fill('leader');
  assert.equal(await page.locator('.storage-entry').count(), 1);
  await gamePage.evaluate(() => localStorage.setItem('cstore_extra', '1'));
  await page.locator('#reload-storage').click();
  await page.waitForFunction(() => document.querySelector('#storage-from').textContent.includes('3 hodnoty'));
  assert.equal(await page.locator('#storage-filter').inputValue(), 'leader');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.screenshot({ path: 'test-results/storage-mobile.png', fullPage: true });
  // Editing writes compact JSON back for CODE get(); invalid JSON is refused before it leaves the panel.
  await page.locator('#storage-filter').fill('farm');
  await page.locator('[data-storage=edit][data-key=farm_state]').click();
  await page.locator('.storage-editor').fill('{ "map": "halloween", "kills": 13 }');
  await page.locator('#storage-filter').fill('nothing matches');
  assert.equal(await page.locator('.storage-editor').inputValue(), '{ "map": "halloween", "kills": 13 }');
  await page.locator('#storage-filter').fill('farm');
  await page.locator('.storage-editor').fill('{ map: 1 }');
  await page.locator('[data-storage=save]').click();
  assert.match(await page.locator('#storage-error').textContent(), /Neplatný JSON/);
  await page.locator('.storage-editor').fill('{ "map": "halloween", "kills": 13 }');
  await page.locator('[data-storage=save]').click();
  await page.locator('.storage-editor').waitFor({ state: 'detached' });
  assert.equal(await gamePage.evaluate(() => localStorage.getItem('cstore_farm_state')), '{"map":"halloween","kills":13}');
  assert.match(await page.locator('#storage-list').textContent(), /"kills": 13/);
  await page.screenshot({ path: 'test-results/storage-edited-mobile.png', fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-storage=delete][data-key=farm_state]').click();
  await page.waitForFunction(() => document.querySelector('#storage-from').textContent.includes('2 hodnoty'));
  assert.equal(await gamePage.evaluate(() => localStorage.getItem('cstore_farm_state')), null);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#clear-storage').click();
  assert.equal(await gamePage.evaluate(() => localStorage.getItem('cstore_leader')), '"TestWarrior"');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-storage').click();
  await page.waitForFunction(() => document.querySelector('#storage-from').textContent.includes('0 hodnot'));
  assert.deepEqual(await gamePage.evaluate(() => [localStorage.getItem('cstore_leader'), localStorage.getItem('cstore_extra'), localStorage.getItem('game_setting')]), [null, null, 'hidden']);
  assert.equal(await page.locator('#clear-storage').isDisabled(), true);
  await page.locator('#close-storage').click();
  await page.setViewportSize({ width: 1440, height: 1100 });
  const scriptId = store.snapshot().scripts[0].id;
  await page.locator('[data-nav=editor]').click();
  await page.locator(`.script-item[data-script-id="${scriptId}"]`).click();
  await page.waitForFunction(() => document.querySelector('#script-source').value.includes('saved in game browser'));
  await page.locator('#script-source').fill('game_log("reloaded fixture");');
  assert.match(await page.locator('#dirty-state').textContent(), /Neuložené změny/);
  assert.match(await page.locator('#save-script').textContent(), /Uložit do herního slotu 1 a aktualizovat 1 postavu/);
  await page.locator('#save-script').click();
  await page.waitForFunction(() => document.querySelector('#editor-note').textContent.startsWith('Uloženo'));
  assert.equal(cloudCode.code, 'game_log("reloaded fixture");');
  assert.equal(await gamePage.evaluate(() => window.the_code), cloudCode.code);
  assert.match(await page.locator('#dirty-state').textContent(), /Bez změn/);
  await page.screenshot({ path: 'test-results/editor-desktop.png', fullPage: true });
  await page.locator('[data-nav=overview]').click();
  await page.locator('[data-action=reload]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=reload]').disabled === false);
  assert.ok(runtime.logs.some(l => l.message.includes('reloaded fixture')));
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('toast').hidden = true; });
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator('[data-action=transfer]').click();
  await page.screenshot({ path: 'test-results/transfer-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.locator('#close-transfer').click();
  // A socket loss retries a completely new authenticated game context.
  const id = store.snapshot().characters[0].id;
  await runtime.sessions.get(id).page.evaluate(() => { window.socket.connected = false; });
  await runtime.tick(); assert.equal(runtime.snapshot()[0].status, 'reconnecting');
  runtime.sessions.get(id).nextRetry = 0; await runtime.tick();
  assert.equal(runtime.snapshot()[0].status, 'running');
  // A process crash is recovered too.
  await runtime.browser.close(); crashed = true;
  assert.equal(runtime.snapshot()[0].status, 'reconnecting');
  runtime.sessions.get(id).nextRetry = 0; await runtime.tick();
  assert.equal(runtime.snapshot()[0].status, 'running');
  await runtime.stop(id);
  for (const scenario of ['online', 'unauthenticated', 'not-owned']) {
    alreadyOnline = scenario === 'online'; accountValid = scenario !== 'unauthenticated'; owned = scenario !== 'not-owned';
    const characterVisits = navigations.filter(p => p.startsWith('/character/')).length;
    await runtime.start(id);
    assert.equal(runtime.snapshot()[0].status, 'reconnecting');
    assert.equal(navigations.filter(p => p.startsWith('/character/')).length, characterVisits, `preflight must block ${scenario}`);
    await runtime.stop(id);
  }
  assert.equal(crashed, true);
  await page.locator('#manage-account').click(); await page.locator('#disconnect-account').click();
  await page.locator('#account-dialog').waitFor({ state: 'hidden' });
  assert.equal(config.authCookie, ''); assert.equal((await page.locator('#auth-warning').isVisible()), true);
  await page.locator('#logout').click(); await page.locator('#login').waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('PASS: panel/game login, live map and logs over WebSocket and inventories/bank, CODE set() storage view/edit/delete, encrypted API token, owned character import, shared CODE slot import/save/autosync with API outage recovery, gold/item transfer confirmation and stale inventory refusal, desktop/mobile layout, Chromium game bridge, socket/browser recovery and ownership/online/auth preflight. All game traffic used local fixtures.');
} finally {
  live.close(); app.locals.dispose(); await runtime.close(); await uiBrowser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
