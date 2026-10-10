const $ = id => document.getElementById(id);
let dashboard = null, selectedScript = '', dirty = false, polling = false, active = false;
const pending = new Set();
let ownedCharacters = [], transferInventory = null, transferCharacterId = '', transferQuote = null;
function clearCredentials() { for (const id of ['game-password', 'game-cookie', 'api-token']) $(id).value = ''; }
const number = value => new Intl.NumberFormat('cs-CZ').format(Math.round(Number(value) || 0));
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, method = 'GET', body) {
  const response = await fetch(`/api${url}`, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && data.code === 'SESSION_REQUIRED') { active = false; $('panel').hidden = true; $('login').hidden = false; for (const id of ['account-dialog', 'transfer-dialog', 'character-dialog']) $(id).close(); clearCredentials(); $('owned-characters').replaceChildren(); ownedCharacters = []; }
    throw new Error(data.error + (data.issues ? ` ${data.issues.map(i => `${i.field}: ${i.message}`).join(', ')}` : ''));
  }
  return data;
}
let toastTimer;
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
function scriptOptions(selected = '', empty = 'Bez CODE') { return `<option value="">${empty}</option>${dashboard.scripts.map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escape(s.name)}</option>`).join('')}`; }
function render() {
  const sessions = new Map(dashboard.sessions.map(s => [s.id, s]));
  const running = dashboard.sessions.filter(s => s.status === 'running');
  $('stat-online').innerHTML = `${running.length}<span>/ ${dashboard.config.maxCharacters}</span>`;
  $('stat-scripts').textContent = dashboard.scripts.length;
  $('stat-gold').textContent = running.some(s => s.state) ? number(running.reduce((sum, s) => sum + (s.state?.gold || 0), 0)) : '—';
  $('stat-status').textContent = dashboard.sessions.some(s => s.status === 'reconnecting') ? 'Obnovuji' : running.length ? 'Online' : 'Připraveno';
  $('last-update').textContent = `Aktualizováno ${new Date().toLocaleTimeString('cs-CZ')}`;
  $('uptime').textContent = `UPTIME ${Math.floor(dashboard.uptime / 3600)}h ${Math.floor(dashboard.uptime % 3600 / 60)}m`;
  $('character-count').textContent = String(dashboard.characters.length).padStart(2, '0');
  $('auth-warning').hidden = dashboard.config.authConfigured;
  const account = dashboard.account;
  const accountText = account?.configured ? (account.email ? `Přihlášen: ${account.email}` : 'Herní relace je připravena; ověří se při spuštění postavy.') : 'Účet není připojen';
  $('account-status').textContent = accountText;
  $('account-dialog-status').textContent = accountText;
  $('manage-account').textContent = account?.configured ? 'Spravovat účet' : 'Připojit účet';
  $('disconnect-account').hidden = !account?.configured;
  $('api-status').textContent = dashboard.gameApi?.configured ? 'API token je připojen. Seznam načti tlačítkem.' : 'Připoj API token v dialogu Herní účet.';
  $('load-owned').disabled = !dashboard.gameApi?.configured;
  $('disconnect-token').hidden = !dashboard.gameApi?.configured;
  $('add-character').disabled = dashboard.characters.length >= dashboard.config.maxCharacters;
  $('characters').innerHTML = dashboard.characters.length ? dashboard.characters.map(c => {
    const session = sessions.get(c.id), state = session?.state, status = session?.status || 'stopped', busy = pending.has(c.id);
    const labels = { running: state?.rip ? 'DEAD' : 'ONLINE', starting: 'STARTUJI', reconnecting: 'OBNOVUJI', stopped: 'OFFLINE' };
    const percentage = (value, max) => Math.max(0, Math.min(100, max ? value / max * 100 : 0));
    const script = dashboard.scripts.find(s => s.id === c.scriptId);
    return `<article class="character-card"><div class="card-head"><div class="character-title"><div class="avatar">${escape(c.name.slice(0, 1).toUpperCase())}</div><div><h3>${escape(c.name)}</h3><small>${escape(c.region)} / ${escape(c.server)}${state ? ` · LVL ${state.level}` : ''}</small></div></div><span class="badge ${status}">${labels[status]}</span></div><div class="meter-label"><span>HP</span><span>${state ? `${number(state.hp)} / ${number(state.max_hp)}` : '—'}</span></div><div class="meter"><i style="--fill:${percentage(state?.hp, state?.max_hp)}%"></i></div><div class="meter-label"><span>MP</span><span>${state ? `${number(state.mp)} / ${number(state.max_mp)}` : '—'}</span></div><div class="meter mp"><i style="--fill:${percentage(state?.mp, state?.max_mp)}%"></i></div><div class="details"><span>${state ? escape(state.map) : 'Čeká na spuštění'}</span><span>${state ? `${number(state.gold)} G` : '—'}</span></div><div class="card-script">⌘ ${script ? escape(script.name) : 'Bez skriptu'} ${state ? (state.codeRunning ? ' · CODE běží' : ' · CODE stojí') : ''}${c.autoStart ? ' · autostart' : ''}</div>${session?.error ? `<p class="card-error">${escape(session.error)}</p>` : ''}<div class="actions"><button class="${session ? 'ghost' : 'primary'}" data-action="${session ? 'stop' : 'start'}" data-id="${c.id}" ${busy || (!session && !dashboard.config.authConfigured) ? 'disabled' : ''}>${busy ? 'Pracuji…' : session ? '■ Stop' : '▶ Start'}</button><button class="ghost" data-action="reload" data-id="${c.id}" ${busy || status !== 'running' ? 'disabled' : ''}>↻ CODE</button><button class="ghost" data-action="transfer" data-id="${c.id}" ${busy || status !== 'running' || !state?.codeRunning ? 'disabled' : ''}>Poslat</button><button class="ghost" data-action="edit" data-id="${c.id}" ${busy || session ? 'disabled' : ''}>Upravit</button><button class="ghost danger" data-action="delete" data-id="${c.id}" ${busy || session ? 'disabled' : ''}>Smazat</button></div></article>`;
  }).join('') : '<div class="empty"><h2>Tvůj tým začíná tady.</h2><p>Přidej postavu, přiřaď CODE a spusť první relaci.</p></div>';
  $('script-picker').innerHTML = scriptOptions(selectedScript, 'Nový skript');
  const filter = $('log-filter').value;
  $('log-filter').innerHTML = `<option value="all">Všechny postavy</option><option value="system">Systém</option>${dashboard.characters.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('')}`;
  $('log-filter').value = [...$('log-filter').options].some(o => o.value === filter) ? filter : 'all';
  renderLogs();
}
function renderLogs() {
  const filter = $('log-filter').value, element = $('logs');
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
  const logs = dashboard.logs.filter(l => filter === 'all' || (filter === 'system' ? !l.characterId : l.characterId === filter));
  element.innerHTML = logs.length ? logs.map(l => `<div class="log-line ${l.level === 'error' ? 'error' : ''}"><span class="log-time">${new Date(l.at).toLocaleTimeString('cs-CZ')}</span><span class="log-name">${escape(dashboard.characters.find(c => c.id === l.characterId)?.name || 'SYSTEM')}</span><div class="log-message">${escape(l.message)}</div></div>`).join('') : '<span class="log-time">Zatím žádné logy. Spusť postavu a sleduj její běh.</span>';
  if (nearBottom) element.scrollTop = element.scrollHeight;
}
async function refresh(initial = false) {
  if (polling) return; polling = true;
  try { dashboard = await api('/dashboard'); active = true; $('login').hidden = true; $('panel').hidden = false; render(); }
  catch (error) { if (!initial && active) { $('stat-status').textContent = 'Nedostupné'; $('last-update').textContent = 'Spojení s panelem bylo přerušeno'; } }
  finally { polling = false; }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { await api('/login', 'POST', { username: $('username').value, password: $('password').value }); $('password').value = ''; $('login-error').textContent = ''; await refresh(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/logout', 'POST', {}); active = false; $('panel').hidden = true; $('login').hidden = false; $('script-source').value = ''; $('script-name').value = ''; for (const id of ['account-dialog', 'transfer-dialog', 'character-dialog']) $(id).close(); clearCredentials(); $('owned-characters').replaceChildren(); ownedCharacters = []; selectedScript = ''; dirty = false; }
  catch (error) { toast(error.message, true); }
});
function openAccount() {
  $('game-account-error').textContent = ''; clearCredentials();
  $('account-dialog').showModal();
}
$('open-account').addEventListener('click', openAccount);
$('manage-account').addEventListener('click', openAccount);
$('close-account').addEventListener('click', () => $('account-dialog').close());
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
function openCharacter(character) {
  $('character-form').reset(); $('character-id').value = character?.id || ''; $('dialog-title').textContent = character ? 'Upravit postavu' : 'Přidat postavu';
  $('character-name').value = character?.name || ''; $('character-region').value = character?.region || 'EU'; $('character-server').value = character?.server || 'I'; $('character-autostart').checked = character?.autoStart || false;
  $('character-script').innerHTML = scriptOptions(character?.scriptId || ''); $('character-dialog').showModal();
}
$('add-character').addEventListener('click', () => openCharacter()); $('close-dialog').addEventListener('click', () => $('character-dialog').close());
$('character-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  const id = $('character-id').value;
  try {
    await api(`/characters${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { name: $('character-name').value, region: $('character-region').value, server: $('character-server').value, scriptId: $('character-script').value || null, autoStart: $('character-autostart').checked });
    $('character-dialog').close(); toast('Postava uložena.'); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { event.submitter.disabled = false; }
});
$('characters').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const { id, action } = button.dataset;
  if (action === 'transfer') return openTransfer(id);
  if (action === 'edit') return openCharacter(dashboard.characters.find(c => c.id === id));
  if (action === 'delete' && !confirm('Smazat tuto postavu z panelu?')) return;
  pending.add(id); render();
  try { await api(`/characters/${id}${action === 'delete' ? '' : `/${action}`}`, action === 'delete' ? 'DELETE' : 'POST', {}); toast(action === 'start' ? 'Požadavek zpracován. Stav připojení uvidíš na kartě.' : 'Hotovo.'); }
  catch (error) { toast(error.message, true); }
  finally { pending.delete(id); await refresh(); }
});
function newScript() {
  selectedScript = ''; $('script-picker').value = ''; $('script-name').value = ''; $('script-source').value = '// Adventure Land CODE\n// Vlož vlastní skript a přiřaď ho postavě.\n'; $('delete-script').hidden = true; dirty = false; $('editor-note').textContent = 'Uložení nemění běžící CODE.';
}
$('new-script').addEventListener('click', () => { if (!dirty || confirm('Zahodit neuložené změny?')) newScript(); });
$('script-picker').addEventListener('change', async () => {
  const id = $('script-picker').value;
  if (dirty && !confirm('Zahodit neuložené změny?')) { $('script-picker').value = selectedScript; return; }
  if (!id) return newScript();
  try { const script = await api(`/scripts/${id}`); selectedScript = id; $('script-name').value = script.name; $('script-source').value = script.source; $('delete-script').hidden = false; dirty = false; $('editor-note').textContent = 'Uložení nemění běžící CODE.'; }
  catch (error) { $('script-picker').value = selectedScript; toast(error.message, true); }
});
for (const id of ['script-name', 'script-source']) $(id).addEventListener('input', () => { dirty = true; $('editor-note').textContent = 'Neuložené změny'; });
$('script-source').addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const field = event.target; field.setRangeText('  ', field.selectionStart, field.selectionEnd, 'end'); field.dispatchEvent(new Event('input')); }
});
$('save-script').addEventListener('click', async () => {
  $('save-script').disabled = true;
  try {
    const script = await api(`/scripts${selectedScript ? `/${selectedScript}` : ''}`, selectedScript ? 'PUT' : 'POST', { name: $('script-name').value, source: $('script-source').value });
    if (!selectedScript) selectedScript = script.id;
    dirty = false; $('delete-script').hidden = false; $('editor-note').textContent = 'Uloženo. Pro nasazení použij ↻ CODE.'; toast('Skript uložen.'); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { $('save-script').disabled = false; }
});
$('delete-script').addEventListener('click', async () => {
  if (!selectedScript || !confirm('Smazat tento skript?')) return;
  try { await api(`/scripts/${selectedScript}`, 'DELETE', {}); newScript(); await refresh(); } catch (error) { toast(error.message, true); }
});
$('log-filter').addEventListener('change', renderLogs);
function renderOwned() {
  $('owned-characters').innerHTML = ownedCharacters.length ? ownedCharacters.map((c, index) => `<div class="owned-row"><div><strong>${escape(c.name)}</strong><small>${escape(c.class)} · LVL ${number(c.level)}${c.online ? ' · online' : ''}</small></div><button class="ghost" data-owned-index="${index}">Přidat do panelu</button></div>`).join('') : '<p class="muted">API nevrátilo žádné postavy.</p>';
}
$('account-dialog').addEventListener('close', clearCredentials);
$('api-token-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; $('game-account-error').textContent = '';
  try {
    const result = await api('/account/token', 'POST', { token: $('api-token').value.trim() });
    ownedCharacters = result.characters; renderOwned(); await refresh(); $('account-dialog').close(); toast('API token připojen.');
  } catch (error) { $('game-account-error').textContent = error.message; }
  finally { $('api-token').value = ''; event.submitter.disabled = false; }
});
$('disconnect-token').addEventListener('click', async () => {
  $('disconnect-token').disabled = true;
  try { await api('/account/token/disconnect', 'POST', {}); ownedCharacters = []; $('owned-characters').replaceChildren(); await refresh(); toast('API token odpojen.'); }
  catch (error) { $('game-account-error').textContent = error.message; }
  finally { $('disconnect-token').disabled = false; }
});
$('load-owned').addEventListener('click', async () => {
  $('load-owned').disabled = true;
  try { ownedCharacters = (await api('/owned-characters')).characters; renderOwned(); }
  catch (error) { toast(error.message, true); }
  finally { $('load-owned').disabled = !dashboard.gameApi?.configured; }
});
$('owned-characters').addEventListener('click', event => {
  const button = event.target.closest('[data-owned-index]');
  if (button) openCharacter({ name: ownedCharacters[Number(button.dataset.ownedIndex)].name });
});
function invalidateTransfer() { transferQuote = null; $('transfer-review').hidden = true; }
function transferFields() {
  const item = $('transfer-type').value === 'item';
  $('transfer-item-fields').hidden = !item; $('transfer-gold-fields').hidden = item;
  $('transfer-amount').required = !item; $('transfer-item').required = item; $('transfer-quantity').required = item;
  $('transfer-amount').disabled = item; $('transfer-item').disabled = !item; $('transfer-quantity').disabled = !item;
  invalidateTransfer();
}
async function openTransfer(id) {
  try {
    const inventory = await api(`/characters/${id}/inventory`);
    transferCharacterId = id; transferInventory = inventory;
    $('transfer-form').reset(); invalidateTransfer(); $('transfer-error').textContent = ''; $('transfer-result').textContent = '';
    $('transfer-from').textContent = `${inventory.name} · ${number(inventory.gold)} G`;
    $('transfer-item').innerHTML = inventory.items.filter(item => !item.locked).map(item => `<option value="${item.index}">${escape(item.name)} +${number(item.level)} · ${number(item.quantity)} ks · slot ${item.index}</option>`).join('');
    const recipients = new Set([...ownedCharacters.map(c => c.name), ...dashboard.characters.map(c => c.name)]);
    $('recipient-names').innerHTML = [...recipients].filter(name => name.toLowerCase() !== inventory.name.toLowerCase()).map(name => `<option value="${escape(name)}"></option>`).join('');
    transferFields(); if (!$('transfer-dialog').open) $('transfer-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}
$('close-transfer').addEventListener('click', () => $('transfer-dialog').close());
$('reload-transfer').addEventListener('click', async () => {
  $('reload-transfer').disabled = true;
  try { await openTransfer(transferCharacterId); } finally { $('reload-transfer').disabled = false; }
});
$('transfer-dialog').addEventListener('close', invalidateTransfer);
$('transfer-form').addEventListener('input', invalidateTransfer);
$('transfer-type').addEventListener('change', transferFields);
$('transfer-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true; invalidateTransfer(); $('transfer-error').textContent = ''; $('transfer-result').textContent = '';
  const body = { characterId: transferCharacterId, type: $('transfer-type').value, to: $('transfer-to').value };
  if (body.type === 'gold') body.amount = Number($('transfer-amount').value);
  else {
    body.index = Number($('transfer-item').value); body.quantity = Number($('transfer-quantity').value);
    body.fingerprint = transferInventory.items.find(item => item.index === body.index)?.fingerprint || '';
  }
  try {
    const quote = await api('/transfers/prepare', 'POST', body);
    // Do not show an obsolete confirmation if the form changed during the request.
    const current = body.type === $('transfer-type').value && body.to === $('transfer-to').value &&
      (body.type === 'gold' ? body.amount === Number($('transfer-amount').value) : body.index === Number($('transfer-item').value) && body.quantity === Number($('transfer-quantity').value));
    if (!current || !$('transfer-dialog').open) return;
    transferQuote = quote;
    $('transfer-summary').textContent = `${quote.from} → ${quote.to}: ${quote.type === 'gold' ? `${number(quote.amount)} G` : `${number(quote.quantity)}× ${quote.item} +${quote.level}`}. Potvrzení platí 60 sekund.`;
    $('confirm-transfer').disabled = false; $('transfer-review').hidden = false;
  } catch (error) { $('transfer-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
$('confirm-transfer').addEventListener('click', async () => {
  if (!transferQuote) return;
  const quote = transferQuote; $('confirm-transfer').disabled = true; $('transfer-form').inert = true; $('reload-transfer').disabled = true;
  try {
    const result = await api(`/transfers/${quote.id}/confirm`, 'POST', {});
    $('transfer-result').textContent = result.message + (result.receivedGold !== undefined ? ` Příjemce dostal ${number(result.receivedGold)} G.` : '');
    $('transfer-result').className = result.status === 'confirmed' ? 'muted' : 'error';
    invalidateTransfer(); await refresh();
  } catch (error) { $('transfer-error').textContent = `${error.message} Před dalším převodem zkontroluj herní stav.`; }
  finally { $('transfer-form').inert = false; $('reload-transfer').disabled = false; }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
await refresh(true); setInterval(() => { if (active) refresh(); }, 5000);
