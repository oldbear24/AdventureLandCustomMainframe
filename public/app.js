const $ = id => document.getElementById(id);
let dashboard = null, selectedScript = '', dirty = false, polling = false, active = false;
const pending = new Set();
let selectedRemoteVersion = null, selectedRemoteSlot = null;
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
function scriptOptions(selected = '', empty = 'Bez CODE', linkedOnly = false) { return `<option value="">${empty}</option>${dashboard.scripts.filter(s => !linkedOnly || s.remoteSlot).map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escape(s.name)}${s.remoteSlot ? ` · slot ${escape(s.remoteSlot)}` : ' · návrh'}</option>`).join('')}`; }

const views = ['overview', 'editor', 'logs'];
function showView(view) {
  if (!views.includes(view)) view = 'overview';
  for (const name of views) $(`view-${name}`).hidden = name !== view;
  for (const link of document.querySelectorAll('[data-view-link]')) {
    if (link.dataset.viewLink === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'logs') scrollLogsToBottom();
}
const usersOf = scriptId => dashboard.characters.filter(c => c.scriptId === scriptId);
const isRunning = id => dashboard.sessions.some(s => s.id === id && s.status === 'running');
const slotLabel = script => script.remoteSlot ? `Herní slot ${script.remoteSlot} · verze ${script.remoteVersion ?? '?'}` : 'Místní návrh · nelze spustit';

function renderSetup() {
  const steps = [
    { done: dashboard.config.authConfigured, title: 'Připoj herní účet', hint: 'E-mail a heslo Adventure Land, nebo cookie u Steam účtu.', action: 'account', label: 'Připojit účet' },
    { done: !!dashboard.gameApi?.configured, title: 'Připoj API token', hint: 'Token z Mainframe → Connect an AI. Slouží pro seznam postav a CODE sloty.', action: 'token', label: 'Vložit token' },
    { done: dashboard.scripts.some(s => s.remoteSlot), title: 'Propoj CODE slot', hint: 'V CODE editoru načti herní sloty a propoj ten, který mají postavy spouštět.', action: 'editor', label: 'Otevřít editor' },
    { done: dashboard.characters.length > 0, title: 'Přidej postavu', hint: 'Zvol jméno, server a propojený CODE slot.', action: 'add', label: 'Přidat postavu' },
  ];
  $('setup').hidden = steps.every(step => step.done);
  $('setup-steps').innerHTML = steps.map((step, index) => `<li class="${step.done ? 'done' : ''}"><span class="check-mark" aria-hidden="true">${step.done ? '✓' : index + 1}</span><span class="step-text">${escape(step.title)}${step.done ? ' <span class="sr-only">(hotovo)</span>' : `<small>${escape(step.hint)}</small>`}</span>${step.done ? '' : `<button class="ghost" data-setup-action="${step.action}">${escape(step.label)}</button>`}</li>`).join('');
}
function characterCard(c, session) {
  const state = session?.state, status = session?.status || 'stopped', busy = pending.has(c.id);
  const dead = status === 'running' && state?.rip;
  const labels = { running: dead ? 'DEAD' : 'ONLINE', starting: 'STARTUJI', reconnecting: 'OBNOVUJI', stopped: 'OFFLINE' };
  const percentage = (value, max) => Math.max(0, Math.min(100, max ? value / max * 100 : 0));
  const script = dashboard.scripts.find(s => s.id === c.scriptId);
  const codeState = state ? (state.codeRunning ? '<span class="code-state on">CODE běží</span>' : '<span class="code-state off">CODE stojí</span>') : '';
  const codeBox = `<div class="card-code"><div><strong>⌘ ${script ? escape(script.name) : 'Výchozí CODE postavy'}</strong><small>${script ? escape(slotLabel(script)) : 'Při startu se najde a stáhne automaticky.'}${codeState ? ` · ${codeState}` : ''}</small></div>${script ? `<button class="ghost" data-action="code" data-id="${c.id}">Upravit CODE</button>` : ''}</div>`;
  const error = session?.error || session?.code?.error;
  return `<article class="character-card ${status === 'running' ? 'is-running' : ''}">
    <div class="card-head"><div class="character-title"><div class="avatar">${escape(c.name.slice(0, 1).toUpperCase())}</div><div><h3>${escape(c.name)}</h3><small>${escape(c.region)} ${escape(c.server)}${state ? ` · LVL ${state.level}` : ''}${c.autoStart ? ' · autostart' : ''}</small></div></div><span class="badge ${dead ? 'dead' : status}">${labels[status]}</span></div>
    <div class="meters"><div><div class="meter-label"><span>HP</span><span>${state ? `${number(state.hp)} / ${number(state.max_hp)}` : '—'}</span></div><div class="meter"><i style="--fill:${percentage(state?.hp, state?.max_hp)}%"></i></div></div><div><div class="meter-label"><span>MP</span><span>${state ? `${number(state.mp)} / ${number(state.max_mp)}` : '—'}</span></div><div class="meter mp"><i style="--fill:${percentage(state?.mp, state?.max_mp)}%"></i></div></div></div>
    <div class="details"><span>${state ? escape(state.map) : 'Neběží'}</span><span>${state ? `${number(state.gold)} G` : '—'}</span></div>
    ${codeBox}${error ? `<p class="card-error">${escape(error)}</p>` : ''}
    <div class="actions"><button class="${session ? 'ghost' : 'primary'}" data-action="${session ? 'stop' : 'start'}" data-id="${c.id}" ${busy || (!session && !dashboard.config.authConfigured) ? 'disabled' : ''}>${busy ? 'Pracuji…' : session ? '■ Stop' : '▶ Start'}</button><button class="ghost" data-action="reload" data-id="${c.id}" ${busy || status !== 'running' ? 'disabled' : ''} title="Znovu načíst CODE ze slotu">↻ CODE</button><button class="ghost" data-action="transfer" data-id="${c.id}" ${busy || status !== 'running' || !state?.codeRunning ? 'disabled' : ''}>Poslat</button><button class="ghost" data-action="logs" data-id="${c.id}">Logy</button><span class="spacer"></span><button class="ghost" data-action="edit" data-id="${c.id}" ${busy || session ? 'disabled' : ''} title="${session ? 'Nastavení lze měnit po zastavení' : 'Upravit nastavení postavy'}">Nastavení</button><button class="ghost danger" data-action="delete" data-id="${c.id}" ${busy || session ? 'disabled' : ''}>Smazat</button></div>
  </article>`;
}
function render() {
  const sessions = new Map(dashboard.sessions.map(s => [s.id, s]));
  const running = dashboard.sessions.filter(s => s.status === 'running');
  $('stat-online').innerHTML = `${running.length}<span>/ ${dashboard.config.maxCharacters}</span>`;
  $('stat-scripts').textContent = dashboard.scripts.length;
  $('stat-gold').textContent = running.some(s => s.state) ? number(running.reduce((sum, s) => sum + (s.state?.gold || 0), 0)) : '—';
  $('stat-status').textContent = dashboard.sessions.some(s => s.status === 'reconnecting') ? 'Obnovuji' : running.length ? 'Online' : 'Připraveno';
  $('last-update').textContent = `Aktualizováno ${new Date().toLocaleTimeString('cs-CZ')}`;
  $('uptime').textContent = `UPTIME ${Math.floor(dashboard.uptime / 3600)}h ${Math.floor(dashboard.uptime % 3600 / 60)}m`;
  $('auth-warning').hidden = dashboard.config.authConfigured;
  renderSetup();
  const account = dashboard.account;
  const accountText = account?.configured ? (account.email ? `Přihlášen: ${account.email}` : 'Herní relace je připravena; ověří se při spuštění postavy.') : 'Účet není připojen';
  $('account-status').textContent = accountText;
  $('account-dialog-status').textContent = accountText;
  $('manage-account').textContent = account?.configured ? 'Spravovat účet' : 'Připojit účet';
  $('disconnect-account').hidden = !account?.configured;
  $('api-status').textContent = dashboard.gameApi?.configured ? 'API token je připojen. Seznam načti tlačítkem.' : 'Připoj API token v dialogu Herní účet.';
  $('load-owned').disabled = !dashboard.gameApi?.configured;
  $('disconnect-token').hidden = !dashboard.gameApi?.configured;
  $('load-code-slots').disabled = !dashboard.gameApi?.configured;
  $('add-character').disabled = dashboard.characters.length >= dashboard.config.maxCharacters;
  $('characters').innerHTML = dashboard.characters.length ? dashboard.characters.map(c => characterCard(c, sessions.get(c.id))).join('') : '<div class="empty"><h2>Tvůj tým začíná tady.</h2><p>Přidej postavu, přiřaď jí herní CODE slot a spusť ji.</p></div>';
  renderScriptList(); updateEditingHeader();
  const filter = $('log-filter').value;
  const options = `<option value="all">Všechny postavy</option><option value="system">Systém</option>${dashboard.characters.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('')}`;
  // Rebuild only on change, so an open dropdown is not closed by the 5 s refresh.
  if ($('log-filter').dataset.options !== options) { $('log-filter').innerHTML = options; $('log-filter').dataset.options = options; }
  $('log-filter').value = [...$('log-filter').options].some(o => o.value === filter) ? filter : 'all';
  renderLogs();
}
function renderScriptList() {
  $('script-list').innerHTML = dashboard.scripts.length ? dashboard.scripts.map(script => {
    const users = usersOf(script.id).map(c => c.name + (isRunning(c.id) ? ' (běží)' : ''));
    return `<button class="script-item" role="listitem" data-script-id="${script.id}" aria-current="${script.id === selectedScript}"><strong>${escape(script.name)}</strong><span class="tag ${script.remoteSlot ? 'slot' : 'draft'}">${script.remoteSlot ? `SLOT ${escape(script.remoteSlot)} · v${escape(script.remoteVersion ?? '?')}` : 'NÁVRH'}</span><small>${users.length ? `Používá: ${escape(users.join(', '))}` : 'Nepoužívá žádná postava'}</small></button>`;
  }).join('') : '<p class="muted">Zatím žádné skripty. Načti herní slot níže.</p>';
}
function updateEditingHeader() {
  const script = dashboard?.scripts.find(s => s.id === selectedScript);
  $('editing-name').textContent = $('script-name').value.trim() || script?.name || 'Nový návrh';
  const chips = [];
  if (script?.remoteSlot) chips.push(`<span class="meta-chip slot">Herní slot ${escape(script.remoteSlot)} · verze ${escape(selectedRemoteVersion ?? script.remoteVersion ?? '?')}</span>`);
  else chips.push(`<span class="meta-chip draft">${script ? 'Místní návrh' : 'Nový místní návrh'} · postavy ho nespustí, dokud ho nepropojíš s herním slotem</span>`);
  if (script) {
    const users = usersOf(script.id);
    chips.push(users.length ? users.map(c => `<span class="meta-chip ${isRunning(c.id) ? 'running' : ''}">${escape(c.name)}${isRunning(c.id) ? ' · běží' : ''}</span>`).join('') : '<span class="meta-chip">Nepřiřazeno žádné postavě</span>');
  }
  $('editing-meta').innerHTML = chips.join('');
  $('dirty-state').textContent = dirty ? '● Neuložené změny' : 'Bez změn';
  $('dirty-state').className = `state-pill ${dirty ? 'dirty' : 'saved'}`;
  document.querySelector('.editor-panel').classList.toggle('is-dirty', dirty);
  $('nav-dirty').hidden = !dirty;
  const runningUsers = script ? usersOf(script.id).filter(c => isRunning(c.id)).length : 0;
  $('save-script').textContent = script?.remoteSlot ? `Uložit do herního slotu ${script.remoteSlot}${runningUsers ? ` a aktualizovat ${runningUsers} ${runningUsers === 1 ? 'postavu' : 'postavy'}` : ''}` : 'Uložit návrh';
  const source = $('script-source').value;
  $('source-stats').textContent = `${source.split('\n').length} řádků · ${number(source.length)} znaků`;
  $('import-target').textContent = script ? `Načtení nahradí obsah skriptu „${script.name}“ obsahem vybraného slotu.` : 'Načtení vytvoří nový propojený skript.';
}
function scrollLogsToBottom() { $('logs').scrollTop = $('logs').scrollHeight; $('logs-bottom').hidden = true; }
function renderLogs() {
  const filter = $('log-filter').value, element = $('logs');
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
  const logs = dashboard.logs.filter(l => filter === 'all' || (filter === 'system' ? !l.characterId : l.characterId === filter));
  element.innerHTML = logs.length ? logs.map(l => `<div class="log-line ${l.level === 'error' ? 'error' : ''}"><span class="log-time">${new Date(l.at).toLocaleTimeString('cs-CZ')}</span><span class="log-name">${escape(dashboard.characters.find(c => c.id === l.characterId)?.name || 'SYSTEM')}</span><div class="log-message">${escape(l.message)}</div></div>`).join('') : '<span class="log-time">Zatím žádné logy. Spusť postavu a sleduj její běh.</span>';
  if (nearBottom) scrollLogsToBottom();
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
  try { await api('/logout', 'POST', {}); active = false; $('panel').hidden = true; $('login').hidden = false; $('script-source').value = ''; $('script-name').value = ''; for (const id of ['account-dialog', 'transfer-dialog', 'character-dialog']) $(id).close(); clearCredentials(); $('owned-characters').replaceChildren(); ownedCharacters = []; selectedScript = ''; selectedRemoteVersion = selectedRemoteSlot = null; dirty = false; }
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
  $('character-form').reset(); $('character-id').value = character?.id || ''; $('dialog-title').textContent = character?.id ? `Nastavení postavy ${character.name}` : 'Přidat postavu';
  $('character-name').value = character?.name || ''; $('character-region').value = character?.region || 'EU'; $('character-server').value = character?.server || 'I'; $('character-autostart').checked = character?.autoStart || false;
  $('character-script').innerHTML = scriptOptions(character?.scriptId || '', 'Automaticky – výchozí CODE postavy', true);
  const scriptHint = () => { $('character-script-hint').textContent = $('character-script').value ? 'Před každým startem se CODE stáhne z vybraného herního slotu.' : 'Při startu se najde výchozí CODE slot postavy ve hře, stáhne se a přiřadí. Vyžaduje API token.'; };
  $('character-script').onchange = scriptHint; scriptHint();
  $('character-dialog').showModal();
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
  if (action === 'logs') { $('log-filter').value = id; showView('logs'); renderLogs(); return scrollLogsToBottom(); }
  if (action === 'code') {
    const scriptId = dashboard.characters.find(c => c.id === id)?.scriptId;
    if (scriptId === selectedScript || await selectScript(scriptId)) showView('editor');
    return;
  }
  if (action === 'delete' && !confirm('Smazat tuto postavu z panelu?')) return;
  pending.add(id); render();
  try { await api(`/characters/${id}${action === 'delete' ? '' : `/${action}`}`, action === 'delete' ? 'DELETE' : 'POST', {}); toast(action === 'start' ? 'CODE stažen, postava se připojuje. Stav uvidíš na kartě.' : 'Hotovo.'); }
  catch (error) { toast(error.message, true); }
  finally { pending.delete(id); await refresh(); }
});
function newScript() {
  selectedScript = ''; selectedRemoteVersion = selectedRemoteSlot = null; $('script-name').value = ''; $('script-source').value = '// Adventure Land CODE\n// Vlož vlastní skript a přiřaď ho postavě.\n'; $('delete-script').hidden = true; dirty = false; $('editor-note').textContent = 'Místní návrh. Pro běh ho propoj s herním slotem.';
  if (dashboard) { renderScriptList(); updateEditingHeader(); }
}
function setEditor(script) {
  selectedScript = script.id; selectedRemoteVersion = script.remoteVersion || null; selectedRemoteSlot = script.remoteSlot || null;
  $('script-name').value = script.name; $('script-source').value = script.source;
  $('delete-script').hidden = false; dirty = false;
  $('delete-script').textContent = selectedRemoteSlot ? 'Odpojit slot z panelu' : 'Smazat návrh';
  $('editor-note').textContent = selectedRemoteSlot ? 'Uložení zapíše herní slot a aktualizuje postavy, které ho spouští.' : 'Místní návrh. Pro běh ho propoj s herním slotem.';
  if (dashboard) { renderScriptList(); updateEditingHeader(); }
}
async function selectScript(id) {
  if (dirty && !confirm('V editoru máš neuložené změny. Zahodit je?')) return false;
  if (!id) { newScript(); return true; }
  document.querySelector('.editor-panel').inert = true;
  try { setEditor(await api(`/scripts/${id}`)); return true; }
  catch (error) { toast(error.message, true); return false; }
  finally { document.querySelector('.editor-panel').inert = false; }
}
$('load-code-slots').addEventListener('click', async () => {
  $('load-code-slots').disabled = true;
  try {
    const { slots } = await api('/code-slots');
    $('code-slot-picker').innerHTML = slots.map(slot => `<option value="${escape(slot.slot)}">${escape(slot.slot)} · ${escape(slot.name)}</option>`).join('');
    if (selectedRemoteSlot && slots.some(slot => slot.slot === selectedRemoteSlot)) $('code-slot-picker').value = selectedRemoteSlot;
    $('import-code-slot').disabled = slots.length === 0;
    if (!slots.length) toast('Ve hře nejdřív ulož CODE do slotu.', true);
  } catch (error) { toast(error.message, true); }
  finally { $('load-code-slots').disabled = !dashboard.gameApi?.configured; }
});
$('import-code-slot').addEventListener('click', async () => {
  const slot = $('code-slot-picker').value;
  if (!slot) return;
  if ((dirty || (selectedScript && !selectedRemoteSlot && $('script-source').value)) && !confirm('Načíst obsah herního slotu místo obsahu v editoru?')) return;
  $('import-code-slot').disabled = true; document.querySelector('.editor-panel').inert = true;
  try {
    const script = await api(`/code-slots/${encodeURIComponent(slot)}/import`, 'POST', { scriptId: selectedScript || null });
    await refresh(); setEditor(script); toast('Herní slot propojen.');
  } catch (error) { toast(error.message, true); }
  finally { $('import-code-slot').disabled = false; document.querySelector('.editor-panel').inert = false; }
});
$('new-script').addEventListener('click', () => selectScript(''));
$('script-list').addEventListener('click', event => {
  const item = event.target.closest('[data-script-id]');
  if (item && item.dataset.scriptId !== selectedScript) selectScript(item.dataset.scriptId);
});
for (const id of ['script-name', 'script-source']) $(id).addEventListener('input', () => { dirty = true; $('editor-note').textContent = 'Změny zatím nejsou uložené.'; updateEditingHeader(); });
$('script-source').addEventListener('keydown', event => {
  if (event.key === 'Tab') { event.preventDefault(); const field = event.target; field.setRangeText('  ', field.selectionStart, field.selectionEnd, 'end'); field.dispatchEvent(new Event('input')); }
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); $('save-script').click(); }
});
$('save-script').addEventListener('click', async () => {
  $('save-script').disabled = true; document.querySelector('.editor-panel').inert = true;
  try {
    const script = await api(`/scripts${selectedScript ? `/${selectedScript}` : ''}`, selectedScript ? 'PUT' : 'POST', { name: $('script-name').value, source: $('script-source').value, ...(selectedScript ? { expectedVersion: selectedRemoteVersion } : {}) });
    await refresh(); setEditor(script);
    $('editor-note').textContent = script.remoteSlot ? `Uloženo do herního slotu ${script.remoteSlot}. Běh postav se synchronizuje.` : 'Uloženo jako návrh. Pro běh načti společný herní slot.';
    toast(script.remoteSlot ? 'Herní slot uložen. Běh postav se synchronizuje.' : 'Návrh uložen.');
  } catch (error) { toast(error.message, true); }
  finally { $('save-script').disabled = false; document.querySelector('.editor-panel').inert = false; }
});
$('delete-script').addEventListener('click', async () => {
  if (!selectedScript || !confirm(selectedRemoteSlot ? 'Odpojit tento slot z panelu? Herní CODE zůstane uložený.' : 'Smazat tento návrh?')) return;
  try { await api(`/scripts/${selectedScript}`, 'DELETE', {}); await refresh(); newScript(); } catch (error) { toast(error.message, true); }
});
$('log-filter').addEventListener('change', () => { renderLogs(); scrollLogsToBottom(); });
$('logs').addEventListener('scroll', () => { const element = $('logs'); $('logs-bottom').hidden = element.scrollHeight - element.scrollTop - element.clientHeight < 70; });
$('logs-bottom').addEventListener('click', scrollLogsToBottom);
for (const link of document.querySelectorAll('[data-view-link]')) link.addEventListener('click', () => showView(link.dataset.viewLink));
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
$('setup-steps').addEventListener('click', event => {
  const action = event.target.closest('[data-setup-action]')?.dataset.setupAction;
  if (action === 'account') openAccount();
  if (action === 'token') { openAccount(); $('token-option').open = true; $('api-token').focus(); }
  if (action === 'editor') showView('editor');
  if (action === 'add') openCharacter();
});
function renderOwned() {
  const added = new Set(dashboard.characters.map(c => c.name.toLowerCase()));
  $('owned-characters').innerHTML = ownedCharacters.length ? ownedCharacters.map((c, index) => `<div class="owned-row"><div><strong>${escape(c.name)}</strong><small>${escape(c.class)} · LVL ${number(c.level)}${c.region ? ` · ${escape(c.region)} ${escape(c.server)}` : ''}${c.online ? ' · online' : ''}${c.codeSlot ? ' · má výchozí CODE slot' : ''}</small></div>${added.has(c.name.toLowerCase()) ? '<span class="muted">V panelu</span>' : `<button class="ghost" data-owned-index="${index}">Přidat do panelu</button>`}</div>`).join('') : '<p class="muted">API nevrátilo žádné postavy.</p>';
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
  if (!button) return;
  const owned = ownedCharacters[Number(button.dataset.ownedIndex)];
  // Prefer an already linked script for the character's default slot; otherwise start detects it.
  const linked = dashboard.scripts.find(s => owned.codeSlot && s.remoteSlot === owned.codeSlot);
  openCharacter({ name: owned.name, region: owned.region || 'EU', server: owned.server || 'I', scriptId: linked?.id || null });
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
showView(location.hash.slice(1));
newScript();
await refresh(true); setInterval(() => { if (active) refresh(); }, 5000);
