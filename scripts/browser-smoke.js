// End-to-end validation against an entirely local game fixture. Never logs into Adventure Land.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { Store } from '../src/store.js';
import { Runtime, GAME_ORIGIN } from '../src/runtime.js';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { GameAccount } from '../src/game-account.js';

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
          window.character={name:'TestWarrior',ctype:'warrior',level:42,hp:1600,max_hp:2000,mp:320,max_mp:500,gold:1234567,map:'main',x:20,y:40};
          window.socket={connected:true};window.code_run=false;window.code_active=false;
          window.add_log=()=>{};window.add_codelog=()=>{};
          window.stop_runner=()=>{document.querySelector('#maincode')?.remove();window.code_run=window.code_active=false};
          window.start_runner=(id,source)=>{window.the_code=source;window.code_run=true;const f=document.createElement('iframe');f.id=id;f.src='/runner';document.body.appendChild(f)};
        </script>` : url.pathname === '/runner' ? `<!doctype html><body><script>parent.code_active=true;window.character=parent.character;window.game_log=parent.add_codelog;const s=document.createElement('script');s.textContent=parent.the_code;document.body.appendChild(s);</script>` : '<!doctype html><body>fixture</body>';
        await route.fulfill({ contentType: 'text/html', body });
      });
      return context;
    };
    return browser;
  },
};
const runtime = new Runtime(config, store, browserType);
const account = new GameAccount(config, runtime, async (url, options) => {
  assert.equal(url, `${GAME_ORIGIN}/api/signup_or_login`);
  assert.equal(JSON.parse(options.body).only_login, true);
  if (JSON.parse(options.body).password !== 'fixture-game-password') return new Response(JSON.stringify({ failed: true, reason: 'wrong_password' }), { status: 401 });
  return new Response(JSON.stringify({ success: true, user: 'fixture-user', auth: 'fixture-auth-secret' }), { status: 200 });
}); await account.init();
const app = createApp(config, store, runtime, account);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let uiBrowser;
try {
  uiBrowser = await chromium.launch({ headless: true });
  const page = await uiBrowser.newPage({ viewport: { width: 1440, height: 1100 } });
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
  await page.locator('#script-name').fill('Fixture warrior');
  await page.locator('#script-source').fill('game_log("fixture CODE ready"); console.log("browser bridge verified");');
  await page.locator('#save-script').click();
  await page.waitForFunction(() => document.querySelector('#script-picker').options.length === 2);
  await page.locator('#add-character').click();
  await page.locator('#character-name').fill('TestWarrior');
  await page.locator('#character-script').selectOption({ label: 'Fixture warrior' });
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
  assert.equal(await page.locator('.meter i').first().evaluate(element => Math.round(element.getBoundingClientRect().width / element.parentElement.getBoundingClientRect().width * 100)), 80);
  const scriptId = store.snapshot().scripts[0].id;
  await page.locator('#script-picker').selectOption(scriptId);
  await page.waitForFunction(() => document.querySelector('#script-source').value.includes('fixture CODE ready'));
  await page.locator('#script-source').fill('game_log("reloaded fixture");');
  await page.locator('#save-script').click();
  await page.waitForFunction(() => document.querySelector('#editor-note').textContent.startsWith('Uloženo'));
  assert.equal(runtime.logs.some(l => l.message.includes('reloaded fixture')), false);
  await page.locator('[data-action=reload]').click();
  await page.waitForFunction(() => document.querySelector('[data-action=reload]').disabled === false);
  assert.ok(runtime.logs.some(l => l.message.includes('reloaded fixture')));
  await mkdir('test-results', { recursive: true });
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById('toast').hidden = true; });
  await page.screenshot({ path: 'test-results/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/dashboard-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
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
  console.log('PASS: panel and game account login/logout, encrypted credentials, UI edit/save/reload, desktop/mobile layout, real Chromium game bridge, socket/browser recovery and ownership/online/auth preflight. All game traffic used local fixtures.');
} finally {
  app.locals.dispose(); await runtime.close(); await uiBrowser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
