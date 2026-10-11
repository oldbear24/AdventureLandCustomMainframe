// Shared by every panel page: API calls, login, the account dialog, dashboard polling and the live WebSocket.
// Each page module imports this, registers its hooks with on() and calls boot().
export const $ = id => document.getElementById(id);
export const page = document.body.dataset.page;
export const number = value => new Intl.NumberFormat('cs-CZ').format(Math.round(Number(value) || 0));
export const decimal = value => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(value);
export const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const percentage = (value, max) => Math.max(0, Math.min(100, max ? value / max * 100 : 0));
export const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
export const shortSlot = slot => String(slot).length > 16 ? `${String(slot).slice(0, 7)}…${String(slot).slice(-5)}` : String(slot);
export const duration = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor(s % 86_400 / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`;
};
export const classColors = { warrior: '#f2a65a', mage: '#8fc3f5', priest: '#f5e08f', ranger: '#9fe08a', rogue: '#c69cf5', paladin: '#f5c2d6', merchant: '#bcf878' };
export const LOG_LIMIT = 200;
// Game icons are tiles of a sprite sheet proxied by the panel; scaled with crisp pixels.
export function itemIcon(icon, size = 32) {
  if (!icon) return '<span class="item-icon missing" aria-hidden="true"></span>';
  const scale = size / icon.size, px = value => `${Math.round(value * scale)}px`;
  return `<span class="item-icon" aria-hidden="true" style="background-image:url('/api/item-sheets/${encodeURIComponent(icon.sheet)}');background-position:${px(-icon.x)} ${px(-icon.y)};background-size:${px(icon.width)} ${px(icon.height)}"></span>`;
}

// Tables show a page of rows at a time. The page lives in the address (?page=), the page size is
// remembered per table in the browser.
export const PAGE_SIZES = [25, 50, 100, 200];
export function pageSize(key, fallback = 50) {
  try { const size = Number(localStorage.getItem(`mainframe-page-size:${key}`)); return PAGE_SIZES.includes(size) ? size : fallback; }
  catch { return fallback; }
}
export function savePageSize(key, size) { try { localStorage.setItem(`mainframe-page-size:${key}`, String(size)); } catch { /* Storage may be unavailable. */ } }
export const pageFromUrl = () => Math.max(1, Number.parseInt(new URLSearchParams(location.search).get('page'), 10) || 1);
export function savePageInUrl(page) {
  const url = new URL(location.href);
  if (page > 1) url.searchParams.set('page', String(page)); else url.searchParams.delete('page');
  history.replaceState(null, '', url);
}
// One page of rows already in the browser; a page past the end shows the last one.
export function paginate(rows, page, size) {
  const pages = Math.max(1, Math.ceil(rows.length / size)), current = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages, total: rows.length, size };
}
// Page numbers around the current one, the first and the last, with gaps between them.
export function pageNumbers(page, pages) {
  const shown = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter(n => n >= 1 && n <= pages));
  const out = [];
  for (const n of [...shown].sort((a, b) => a - b)) { if (out.length && n - out.at(-1) > 1) out.push(null); out.push(n); }
  return out;
}
// Renders "51–100 z 1 234 · ‹ 1 … 3 4 5 … 25 › · Na stránku" into element; go(page, size) is called on a change.
export function pager(element, { page, pages, total, size }, go) {
  if (!element) return;
  if (total <= PAGE_SIZES[0]) { element.hidden = true; element.replaceChildren(); return; }
  element.hidden = false;
  const first = (page - 1) * size + 1, last = Math.min(total, page * size);
  const button = (target, label, text, current = false) => `<button type="button" class="ghost small-button" data-page="${target}" aria-label="${label}"${current ? ' aria-current="page"' : ''}${target < 1 || target > pages ? ' disabled' : ''}>${text}</button>`;
  element.innerHTML = `<span class="pager-info">${number(first)}–${number(last)} z ${number(total)}</span>
    <span class="pager-pages">${button(page - 1, 'Předchozí stránka', '‹')}${pageNumbers(page, pages).map(n => n === null ? '<span class="pager-gap" aria-hidden="true">…</span>' : button(n, `Stránka ${n}`, number(n), n === page)).join('')}${button(page + 1, 'Další stránka', '›')}</span>
    <label class="pager-size">Na stránku <select>${PAGE_SIZES.map(n => `<option value="${n}"${n === size ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;
  element.onclick = event => { const target = event.target.closest('[data-page]'); if (target && !target.disabled && Number(target.dataset.page) !== page) go(Number(target.dataset.page), size); };
  element.onchange = event => { if (event.target.matches('select')) go(Math.floor((page - 1) * size / Number(event.target.value)) + 1, Number(event.target.value)); };
}

// Shared page state. dashboard is replaced by every poll; live states are merged into it.
export const app = { dashboard: null, active: false, liveConnected: false, owned: [], ownedLoadedAt: 0 };
export const runningSessions = () => app.dashboard?.sessions.filter(s => s.status === 'running' && s.state) || [];
export const isRunning = id => !!app.dashboard?.sessions.some(s => s.id === id && s.status === 'running');
export const characterName = id => app.dashboard?.characters.find(c => c.id === id)?.name || '?';

const hooks = { dashboard: [], states: [], logs: [], live: [], owned: [], reset: [] };
export function on(event, handler) { hooks[event].push(handler); }
const emit = (event, ...args) => { for (const handler of hooks[event]) handler(...args); };

export async function api(url, method = 'GET', body) {
  const response = await fetch(`/api${url}`, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && data.code === 'SESSION_REQUIRED') signedOut();
    throw new Error(data.error + (data.issues ? ` ${data.issues.map(i => `${i.field}: ${i.message}`).join(', ')}` : ''));
  }
  return data;
}
let toastTimer;
export function toast(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }

function clearCredentials() { for (const id of ['game-password', 'game-cookie', 'api-token']) $(id).value = ''; }
function signedOut() {
  app.active = false; $('panel').hidden = true; $('login').hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  clearCredentials(); clearOwned(); disconnectLive(); emit('reset');
}

// The account's character list (API token) is shared by several pages; it is kept for the browser tab's
// session so that switching pages does not reload it, and refreshed at most once a minute.
const OWNED_KEY = 'mainframe-owned';
try { const cached = JSON.parse(sessionStorage.getItem(OWNED_KEY)); if (Array.isArray(cached?.list)) { app.owned = cached.list; app.ownedLoadedAt = cached.at; } } catch { /* Storage may be unavailable. */ }
export function setOwned(list) {
  app.owned = list; app.ownedLoadedAt = Date.now();
  try { sessionStorage.setItem(OWNED_KEY, JSON.stringify({ list, at: app.ownedLoadedAt })); } catch { /* Storage may be unavailable. */ }
  emit('owned');
}
function clearOwned() {
  app.owned = []; app.ownedLoadedAt = 0;
  try { sessionStorage.removeItem(OWNED_KEY); } catch { /* Storage may be unavailable. */ }
  emit('owned');
}
export async function loadOwned() { setOwned((await api('/owned-characters')).characters); }
export async function ensureOwned() {
  if (!app.dashboard?.gameApi?.configured || Date.now() - app.ownedLoadedAt < 60_000) return;
  app.ownedLoadedAt = Date.now();
  try { await loadOwned(); } catch { /* The pages work without the saved account list. */ }
}
let mapListRequest = null;
// Map keys and titles, loaded once per page.
export function mapList() {
  mapListRequest ??= api('/maps').then(result => result.maps).catch(error => { mapListRequest = null; throw error; });
  return mapListRequest;
}

// Account dialog and login are part of every page.
export function openAccount() {
  $('game-account-error').textContent = ''; clearCredentials();
  $('account-dialog').showModal();
}
function renderShell() {
  const { dashboard } = app;
  $('uptime').textContent = `UPTIME ${Math.floor(dashboard.uptime / 3600)}h ${Math.floor(dashboard.uptime % 3600 / 60)}m`;
  const account = dashboard.account;
  $('account-dialog-status').textContent = account?.configured ? (account.email ? `Přihlášen: ${account.email}` : 'Herní relace je připravena; ověří se při spuštění postavy.') : 'Účet není připojen';
  $('disconnect-account').hidden = !account?.configured;
  $('disconnect-token').hidden = !dashboard.gameApi?.configured;
  const notify = dashboard.config.notifications || {};
  const channels = [notify.discord && 'Discord', notify.telegram && 'Telegram'].filter(Boolean);
  $('notify-status').textContent = channels.length ? `Upozornění se posílají na: ${channels.join(' a ')}.` : 'Webhook není nastaven. Doplň do .env DISCORD_WEBHOOK_URL nebo TELEGRAM_BOT_TOKEN a TELEGRAM_CHAT_ID a restartuj kontejner.';
  $('test-notify').disabled = !channels.length;
}
// New problems show a toast once; the page title counts characters needing attention.
const baseTitle = document.title;
let seenAlerts = null;
function announceAlerts() {
  const current = new Map();
  for (const session of app.dashboard.sessions) for (const alert of session.alerts || []) current.set(`${session.id}:${alert.type}`, `${characterName(session.id)}: ${alert.message}`);
  if (seenAlerts) {
    const fresh = [...current].filter(([key]) => !seenAlerts.has(key)).map(([, text]) => text);
    if (fresh.length) toast(`⚠ ${fresh.join(' · ')}`, true);
  }
  seenAlerts = new Set(current.keys());
  const affected = app.dashboard.sessions.filter(s => s.alerts?.length).length;
  document.title = `${affected ? `(${affected}) ` : ''}${baseTitle}`;
}

let options = { live: false, logs: false }, polling = false;
export async function refresh(initial = false) {
  if (polling) return; polling = true;
  try {
    // Only the logs page needs log entries; while the WebSocket is open it delivers them instead.
    const withLogs = options.logs && !app.liveConnected;
    const next = await api(withLogs ? '/dashboard' : '/dashboard?logs=0');
    if (!withLogs || !Array.isArray(next.logs)) next.logs = app.dashboard?.logs || [];
    app.dashboard = next; app.active = true; $('login').hidden = true; $('panel').hidden = false;
    if (!next.gameApi?.configured && app.owned.length) clearOwned();
    renderShell(); announceAlerts(); emit('dashboard'); connectLive();
  } catch { if (!initial && app.active) emit('dashboard', 'offline'); }
  finally { polling = false; }
}

// Real-time state over WebSocket for the pages that ask for it; the 5 s dashboard poll stays as a fallback.
let live = null, liveRetry = 0, liveTimer = null;
function connectLive() {
  if (!options.live || live || !app.active || typeof WebSocket === 'undefined') return;
  clearTimeout(liveTimer);
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
  live = socket;
  socket.onopen = () => { liveRetry = 0; app.liveConnected = true; emit('live'); };
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'snapshot') { if (Array.isArray(message.logs) && app.dashboard) { app.dashboard.logs = message.logs.slice(-LOG_LIMIT); emit('logs'); } applyStates(message.sessions); }
    else if (message.type === 'logs') applyLogs(message.logs);
    else applyStates(message.states);
  };
  socket.onclose = event => {
    if (live !== socket) return;
    live = null; app.liveConnected = false; emit('live');
    if (app.active && event.code !== 4401) liveTimer = setTimeout(connectLive, Math.min(30_000, 1000 * 2 ** liveRetry++));
  };
}
function disconnectLive() {
  clearTimeout(liveTimer);
  const socket = live; live = null; app.liveConnected = false;
  socket?.close();
}
function applyStates(states) {
  if (!app.dashboard || !Array.isArray(states)) return;
  for (const { id, state } of states) {
    const session = app.dashboard.sessions.find(s => s.id === id);
    if (session) session.state = state;
  }
  emit('states');
}
// New entries are appended by id; one already received (e.g. also in the snapshot) is skipped.
function applyLogs(logs) {
  if (!app.dashboard || !Array.isArray(logs)) return;
  const last = app.dashboard.logs.at(-1)?.id ?? 0;
  const fresh = logs.filter(l => l.id > last);
  if (!fresh.length) return;
  app.dashboard.logs = app.dashboard.logs.concat(fresh).slice(-LOG_LIMIT);
  emit('logs');
}

function wireShell() {
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try { await api('/login', 'POST', { username: $('username').value, password: $('password').value }); $('password').value = ''; $('login-error').textContent = ''; await refresh(); }
    catch (error) { $('login-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/logout', 'POST', {}); signedOut(); }
    catch (error) { toast(error.message, true); }
  });
  // On narrow screens the navigation folds behind a button that names the current page.
  const current = document.querySelector('.nav-link[aria-current=page]');
  if (current) $('nav-current').textContent = [...current.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim();
  $('nav-toggle').addEventListener('click', () => { const open = document.querySelector('aside').classList.toggle('nav-open'); $('nav-toggle').setAttribute('aria-expanded', open); });
  // Phones show table rows as stacked cells; each cell takes its column's heading as a label.
  const labelTables = () => { for (const table of document.querySelectorAll('.party-table')) { const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()); for (const row of table.querySelectorAll('tbody tr')) [...row.cells].forEach((cell, index) => { if (index && heads[index] && !cell.dataset.label) cell.dataset.label = heads[index]; }); } };
  new MutationObserver(labelTables).observe(document.querySelector('.workspace'), { childList: true, subtree: true });
  $('open-account').addEventListener('click', openAccount);
  $('close-account').addEventListener('click', () => $('account-dialog').close());
  $('account-dialog').addEventListener('close', clearCredentials);
  for (const [formId, endpoint] of [['game-login-form', '/account/login'], ['game-cookie-form', '/account/cookie']]) {
    $(formId).addEventListener('submit', async event => {
      event.preventDefault(); event.submitter.disabled = true; $('game-account-error').textContent = '';
      const body = formId === 'game-login-form' ? { email: $('game-email').value, password: $('game-password').value } : { cookie: $('game-cookie').value };
      try {
        await api(endpoint, 'POST', body); toast(formId === 'game-login-form' ? 'Herní účet přihlášen.' : 'Herní cookie uložena.'); await refresh(); $('account-dialog').close();
      } catch (error) { $('game-account-error').textContent = error.message; }
      finally { $('game-password').value = ''; $('game-cookie').value = ''; event.submitter.disabled = false; }
    });
  }
  $('disconnect-account').addEventListener('click', async () => {
    $('disconnect-account').disabled = true;
    try { await api('/account/disconnect', 'POST', {}); await refresh(); $('account-dialog').close(); toast('Účet odpojen, postavy zastaveny.'); }
    catch (error) { $('game-account-error').textContent = error.message; }
    finally { $('disconnect-account').disabled = false; }
  });
  $('api-token-form').addEventListener('submit', async event => {
    event.preventDefault(); event.submitter.disabled = true; $('game-account-error').textContent = '';
    try {
      const result = await api('/account/token', 'POST', { token: $('api-token').value.trim() });
      setOwned(result.characters); await refresh(); $('account-dialog').close(); toast('API token připojen.');
    } catch (error) { $('game-account-error').textContent = error.message; }
    finally { $('api-token').value = ''; event.submitter.disabled = false; }
  });
  $('disconnect-token').addEventListener('click', async () => {
    $('disconnect-token').disabled = true;
    try { await api('/account/token/disconnect', 'POST', {}); clearOwned(); await refresh(); toast('API token odpojen.'); }
    catch (error) { $('game-account-error').textContent = error.message; }
    finally { $('disconnect-token').disabled = false; }
  });
  $('test-notify').addEventListener('click', async () => {
    $('test-notify').disabled = true;
    try { const result = await api('/notifications/test', 'POST', {}); toast(`Testovací upozornění odesláno (${result.delivered}).`); }
    catch (error) { toast(error.message, true); }
    finally { $('test-notify').disabled = false; }
  });
}

// live: open the WebSocket for real-time states; logs: the page shows log entries.
export async function boot(pageOptions = {}) {
  options = { ...options, ...pageOptions };
  wireShell();
  await refresh(true);
  setInterval(() => { if (app.active) refresh(); }, 5000);
}
