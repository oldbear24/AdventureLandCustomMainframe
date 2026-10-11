// Overview page: character cards, party, batch actions, transfers, CODE storage and the account's characters.
import { $, api, app, boot, characterName, duration, ensureOwned, escape, isRunning, loadOwned, mapList, number, on, openAccount, percentage, refresh, runningSessions, shortSlot, signed, toast } from './core.js';

// Links from the former single-page panel (/#map) open the new pages.
const legacy = location.hash.slice(1);
if (['map', 'inventory', 'editor', 'logs'].includes(legacy)) location.replace(`/${legacy}`);

const pending = new Set();
let transferInventory = null, transferCharacterId = '', transferQuote = null;
const scriptOptions = (selected = '', empty = 'Bez CODE', linkedOnly = false) => `<option value="">${empty}</option>${app.dashboard.scripts.filter(s => !linkedOnly || s.remoteSlot || s.id === selected).map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${escape(s.name)}${s.remoteSlot ? ` · slot ${escape(s.remoteSlot)}` : ' · návrh'}</option>`).join('')}`;
const slotLabel = script => script.remoteSlot ? `Herní slot ${script.remoteSlot} · verze ${script.remoteVersion ?? '?'}` : 'Místní návrh · nelze spustit';
// Sets innerHTML only when it changed, so a refresh does not rebuild the DOM, lose hover or close dropdowns.
function setHtml(element, html) { if (element.dataset.html !== html) { element.innerHTML = html; element.dataset.html = html; } }

function renderSetup() {
  const { dashboard } = app;
  const steps = [
    { done: dashboard.config.authConfigured, title: 'Připoj herní účet', hint: 'E-mail a heslo Adventure Land, nebo cookie u Steam účtu.', action: 'account', label: 'Připojit účet' },
    { done: !!dashboard.gameApi?.configured, title: 'Připoj API token', hint: 'Token z Mainframe → Connect an AI. Slouží pro seznam postav a CODE sloty.', action: 'token', label: 'Vložit token' },
    { done: dashboard.scripts.some(s => s.remoteSlot), title: 'Propoj CODE slot', hint: 'V CODE editoru načti herní sloty a propoj ten, který mají postavy spouštět.', action: 'editor', label: 'Otevřít editor' },
    { done: dashboard.characters.length > 0, title: 'Přidej postavu', hint: 'Zvol jméno, server a propojený CODE slot.', action: 'add', label: 'Přidat postavu' },
  ];
  $('setup').hidden = steps.every(step => step.done);
  setHtml($('setup-steps'), steps.map((step, index) => `<li class="${step.done ? 'done' : ''}"><span class="check-mark" aria-hidden="true">${step.done ? '✓' : index + 1}</span><span class="step-text">${escape(step.title)}${step.done ? ' <span class="sr-only">(hotovo)</span>' : `<small>${escape(step.hint)}</small>`}</span>${step.done ? '' : `<button class="ghost" data-setup-action="${step.action}">${escape(step.label)}</button>`}</li>`).join(''));
}
// Server time offset, so skill cooldowns count down correctly even with a skewed client clock.
let clockOffset = 0;
const openDetails = new Set();
const alertLabels = { dead: 'Mrtvá', idle: 'Nečinná', reconnect: 'Reconnect', potions: 'Lektvary', code: 'CODE' };
const statusLabel = (status, dead) => ({ running: dead ? 'DEAD' : 'ONLINE', starting: 'STARTUJI', reconnecting: 'OBNOVUJI', stopped: 'OFFLINE' })[status];
function sparkline(series) {
  if (!series || series.length < 2) return '';
  const t0 = series[0].t, span = Math.max(1, series.at(-1).t - t0);
  const line = key => {
    const values = series.map(p => p[key]), min = Math.min(0, ...values), max = Math.max(...values), range = max - min || 1;
    return series.map(p => `${((p.t - t0) / span * 100).toFixed(1)},${(28 - (p[key] - min) / range * 26).toFixed(1)}`).join(' ');
  };
  return `<svg class="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline class="spark-xp" points="${line('xp')}"/><polyline class="spark-gold" points="${line('gold')}"/></svg>`;
}
function statsBlock(session) {
  const stats = session?.stats, state = session?.state;
  if (!stats) return '';
  const span = stats.windowMs >= 60_000 ? `za ${duration(stats.windowMs)}` : 'sbírám data';
  const idle = session.status === 'running' && session.idleMs >= 60_000 ? ` · bez aktivity ${duration(session.idleMs)}` : '';
  return `<div class="card-stats"><div class="stat-cells"><span><small>XP/h</small><b>${stats.xpPerHour === null ? '—' : number(stats.xpPerHour)}</b></span><span><small>Gold/h</small><b class="${stats.goldPerHour < 0 ? 'negative' : ''}">${stats.goldPerHour === null ? '—' : signed(stats.goldPerHour)}</b></span><span><small>Další level</small><b>${stats.etaMs === null ? '—' : duration(stats.etaMs)}</b></span></div>${sparkline(stats.series)}<small class="stats-note"><i class="key-xp"></i>XP <i class="key-gold"></i>gold · ${span}${state ? ` · +${number(stats.xpGained)} XP, ${signed(stats.goldChange)} G` : ''}${idle}${session.autoReloads ? ` · auto ↻ ${session.autoReloads}×` : ''}</small></div>`;
}
function conditionChips(state) {
  if (!state?.conditions?.length) return '';
  const order = { debuff: 0, buff: 1, neutral: 2 };
  return `<div class="conditions" aria-label="Aktivní efekty">${[...state.conditions].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name)).map(c => `<span class="condition ${c.kind}">${escape(c.name)}${c.ms !== null && c.ms > 0 ? `<em>${duration(c.ms)}</em>` : ''}</span>`).join('')}</div>`;
}
function skillsBlock(c, session) {
  const skills = session?.state?.skills;
  if (!skills?.length) return '';
  const base = Date.parse(session.state.observedAt) + clockOffset, key = `skills:${c.id}`;
  return `<details class="card-more" data-key="${key}" ${openDetails.has(key) ? 'open' : ''}><summary>Cooldowny skillů <small>${skills.filter(s => s.ms > 0).length}/${skills.length} čeká</small></summary><div class="skill-list">${skills.map(s => `<div class="skill"><span title="${escape(s.key)}">${escape(s.name)}</span><b data-ready-at="${base + s.ms}">${s.ms > 0 ? `${(s.ms / 1000).toFixed(1)} s` : 'připraveno'}</b>${s.cooldown ? `<small>CD ${(s.cooldown / 1000).toFixed(s.cooldown < 10_000 ? 1 : 0)} s</small>` : ''}</div>`).join('')}</div></details>`;
}
// Character sprites are layers of the game's sheets, proxied by the panel; each look is fetched once and kept.
// Without a known look or class (or until the sprite loads) the avatar shows the name's first letter.
const sprites = new Map();
function avatar(c, state) {
  const look = app.dashboard.looks?.[c.id], ctype = state?.ctype || app.owned.find(o => o.name.toLowerCase() === c.name.toLowerCase())?.class;
  const params = new URLSearchParams();
  if (look) {
    params.set('skin', look.skin);
    const cx = Object.entries(look.cx || {}).map(([place, id]) => `${place}:${id}`).join(',');
    if (cx) params.set('cx', cx);
  }
  if (ctype) params.set('class', ctype);
  const query = params.toString(), sprite = query ? sprites.get(query) : null;
  if (query && sprite === undefined) {
    sprites.set(query, null);
    api(`/character-sprites?${query}`).then(result => { sprites.set(query, result); render(); }, () => sprites.set(query, false));
  }
  if (!sprite) return `<div class="avatar">${escape(c.name.slice(0, 1).toUpperCase())}</div>`;
  const layers = sprite.layers.map(l => `<span style="left:${l.left}px;bottom:${l.bottom}px;width:${l.width}px;height:${l.height}px;background-image:url('/api/sprite-sheets/${encodeURIComponent(l.sheet)}');background-position:${l.imageX}px ${l.imageY}px;background-size:${l.imageWidth}px ${l.imageHeight}px"></span>`).join('');
  return `<div class="avatar sprite${state?.rip ? ' dead' : ''}" aria-hidden="true"><div style="width:${sprite.width}px;height:${sprite.height}px">${layers}</div></div>`;
}
function characterCard(c, session) {
  const { dashboard } = app;
  const state = session?.state, status = session?.status || 'stopped', busy = pending.has(c.id);
  const dead = status === 'running' && state?.rip;
  // Automatic CODE has no assigned script; a running character shows the default slot found at its start.
  const automatic = !c.scriptId, script = dashboard.scripts.find(s => s.id === (automatic ? session?.scriptId : c.scriptId));
  const codeState = state ? (state.codeRunning ? '<span class="code-state on">CODE běží</span>' : '<span class="code-state off">CODE stojí</span>') : '';
  const slotText = `${automatic ? 'Výchozí CODE postavy · ' : ''}${script?.remoteSlot ? `herní slot ${shortSlot(script.remoteSlot)} · verze ${script.remoteVersion ?? '?'}` : script ? slotLabel(script) : 'při každém startu se najde a stáhne poslední verze'}`;
  const modules = session?.code?.modules || [];
  const moduleText = modules.length ? `Moduly: ${modules.map(m => `${m.name}${m.version ? ` v${m.version}` : ''}`).join(', ')}` : '';
  const codeBox = `<div class="card-code"><div><strong>⌘ ${script ? escape(script.name) : 'Výchozí CODE postavy'}${automatic ? ' <span class="muted">· auto</span>' : ''}</strong><small title="${escape(script ? slotLabel(script) : '')}">${escape(slotText)}</small>${moduleText ? `<small title="Sloty načtené přes require_code/load_code; jejich změna CODE automaticky znovu načte.">${escape(moduleText)}</small>` : ''}${codeState ? `<small>${codeState}</small>` : ''}</div>${script ? `<a class="button ghost" href="/editor?script=${encodeURIComponent(script.id)}">Upravit CODE</a>` : ''}</div>`;
  const error = session?.error || session?.code?.error;
  const alerts = session?.alerts || [];
  const xp = state?.max_xp ? `<div><div class="meter-label"><span>XP</span><span>${percentage(state.xp, state.max_xp).toFixed(1)} %${session?.stats?.etaMs ? ` · LVL ${state.level + 1} za ${duration(session.stats.etaMs)}` : ''}</span></div><div class="meter xp"><i style="--fill:${percentage(state.xp, state.max_xp)}%"></i></div></div>` : '';
  const supplies = state ? `<div class="details supplies"><span title="Lektvary HP / MP v inventáři" class="${alerts.some(a => a.type === 'potions') ? 'warn' : ''}">⚗ HP ${number(state.potions?.hp)} · MP ${number(state.potions?.mp)}</span><span title="Volná místa v inventáři">▤ volno ${number(state.esize)}${state.isize ? ` / ${number(state.isize)}` : ''}</span>${state.party ? `<span title="Party">⚑ ${escape(state.party.leader)}</span>` : ''}</div>` : '';
  const running = status === 'running';
  return `<article class="character-card ${running ? 'is-running' : ''} ${alerts.length ? 'has-alert' : ''}">
    <div class="card-head"><div class="character-title">${avatar(c, state)}<div><h3>${escape(c.name)}</h3><small>${escape(c.region)} ${escape(c.server)}${state ? ` · LVL ${state.level}` : ''}${c.autoStart ? ' · autostart' : ''}</small></div></div><span class="badge ${dead ? 'dead' : status}">${statusLabel(status, dead)}</span></div>
    ${alerts.length ? `<ul class="card-alerts" role="alert">${alerts.map(a => `<li class="alert-${a.type}"><b>${alertLabels[a.type] || a.type}</b>${escape(a.message)}</li>`).join('')}</ul>` : ''}
    <div class="meters"><div><div class="meter-label"><span>HP</span><span>${state ? `${number(state.hp)} / ${number(state.max_hp)}` : '—'}</span></div><div class="meter"><i style="--fill:${percentage(state?.hp, state?.max_hp)}%"></i></div></div><div><div class="meter-label"><span>MP</span><span>${state ? `${number(state.mp)} / ${number(state.max_mp)}` : '—'}</span></div><div class="meter mp"><i style="--fill:${percentage(state?.mp, state?.max_mp)}%"></i></div></div>${xp}</div>
    ${conditionChips(state)}
    <div class="details"><span>${state ? escape(state.map) : 'Neběží'}</span><span>${state ? `${number(state.gold)} G` : '—'}</span></div>
    ${supplies}${statsBlock(session)}
    ${codeBox}${error ? `<p class="card-error">${escape(error)}</p>` : ''}
    ${skillsBlock(c, session)}
    <div class="actions"><button class="${session ? 'ghost' : 'primary'}" data-action="${session ? 'stop' : 'start'}" data-id="${c.id}" ${busy || (!session && !dashboard.config.authConfigured) ? 'disabled' : ''}>${busy ? 'Pracuji…' : session ? '■ Stop' : '▶ Start'}</button><button class="ghost" data-action="reload" data-id="${c.id}" ${busy || !running ? 'disabled' : ''} title="Znovu načíst CODE ze slotu">↻ CODE</button><button class="ghost" data-action="transfer" data-id="${c.id}" ${busy || !running || !state?.codeRunning ? 'disabled' : ''}>Poslat</button><a class="button ghost" href="/automation?character=${encodeURIComponent(c.id)}" title="Cíl farmení, moduly CODE a co postava právě dělá">Automatizace</a><a class="button ghost" href="/inventory?name=${encodeURIComponent(c.name)}">Inventář</a><button class="ghost" data-action="storage" data-id="${c.id}" ${!running ? 'disabled' : ''} title="Hodnoty uložené CODE funkcí set()">Úložiště</button>${running ? `<a class="button ghost" href="/map?follow=${encodeURIComponent(c.id)}">Mapa</a>` : '<button class="ghost" disabled>Mapa</button>'}<a class="button ghost" href="/logs?character=${encodeURIComponent(c.id)}">Logy</a><span class="spacer"></span><button class="ghost" data-action="edit" data-id="${c.id}" ${busy || session ? 'disabled' : ''} title="${session ? 'Nastavení lze měnit po zastavení' : 'Upravit nastavení postavy'}">Nastavení</button><button class="ghost danger" data-action="delete" data-id="${c.id}" ${busy || session ? 'disabled' : ''}>Smazat</button></div>
  </article>`;
}
// Active characters: a compact table (default) or the full cards; each row opens its card below it.
const VIEW_KEY = 'mainframe-overview-view';
let activeView = 'table';
try { if (localStorage.getItem(VIEW_KEY) === 'cards') activeView = 'cards'; } catch { /* Storage may be unavailable. */ }
const expanded = new Set();
const ownedOf = c => app.owned.find(o => o.name.toLowerCase() === c.name.toLowerCase());
const miniMeter = (value, max, kind, label) => `<div class="meter ${kind}" title="${label} ${number(value)} / ${number(max)}"><i style="--fill:${percentage(value, max)}%"></i></div>`;
function activeRow(c, session) {
  const state = session.state, status = session.status, busy = pending.has(c.id), running = status === 'running', dead = running && state?.rip;
  const alerts = session.alerts || [], stats = session.stats, error = session.error || session.code?.error, owned = ownedOf(c);
  const ctype = state?.ctype || owned?.class, level = state?.level ?? owned?.level, open = expanded.has(c.id);
  const code = !state ? '—' : state.codeRunning ? '<span class="code-state on">běží</span>' : '<span class="code-state off">stojí</span>';
  const perHour = (value, sign) => value === null || value === undefined ? '—' : sign ? signed(value) : number(value);
  return `<tr class="${alerts.length || error ? 'has-alert' : ''}">
    <td><div class="roster-name"><span class="badge ${dead ? 'dead' : status}">${statusLabel(status, dead)}</span><div><strong>${escape(c.name)}</strong><small>${escape(ctype || '—')}${level ? ` · ${number(level)}` : ''}</small></div></div>${alerts.map(a => `<span class="tag alert-tag" title="${escape(a.message)}">${escape(alertLabels[a.type] || a.type)}</span>`).join('')}</td>
    <td>${escape(c.region)} ${escape(c.server)}</td>
    <td>${state?.map ? `<a href="/map?follow=${encodeURIComponent(c.id)}">${escape(mapTitle(state.map))}</a>` : '—'}</td>
    <td class="roster-meters">${state ? miniMeter(state.hp, state.max_hp, 'hp', 'HP') + miniMeter(state.mp, state.max_mp, 'mp', 'MP') : '—'}</td>
    <td>${perHour(stats?.xpPerHour)}</td>
    <td class="${stats?.goldPerHour < 0 ? 'negative' : ''}">${perHour(stats?.goldPerHour, true)}</td>
    <td>${state ? `${number(state.gold)} G` : '—'}</td>
    <td>${code}${error ? ` <span class="tag alert-tag" title="${escape(error)}">chyba</span>` : ''}</td>
    <td><div class="roster-actions"><button class="ghost small-button" data-action="stop" data-id="${c.id}" ${busy ? 'disabled' : ''}>${busy ? 'Pracuji…' : '■ Stop'}</button><button class="ghost small-button" data-action="reload" data-id="${c.id}" ${busy || !running ? 'disabled' : ''} title="Znovu načíst CODE ze slotu" aria-label="Znovu načíst CODE ${escape(c.name)}">↻</button><button class="ghost small-button" data-action="expand" data-id="${c.id}" aria-expanded="${open}">${open ? '▴ Méně' : '▾ Detail'}</button></div></td>
  </tr>${open ? `<tr class="roster-detail"><td colspan="9">${characterCard(c, session)}</td></tr>` : ''}`;
}
function renderActive(sessions, free) {
  const { dashboard } = app;
  const active = dashboard.characters.filter(c => sessions.has(c.id));
  $('active-count').textContent = `${active.length} / ${dashboard.config.maxCharacters}`;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', button.dataset.view === activeView);
  $('characters').className = activeView === 'cards' && active.length ? 'character-grid' : '';
  for (const id of expanded) if (!sessions.has(id)) expanded.delete(id);
  const freeText = free ? `${free === 1 ? 'Volné 1 místo' : `Volná místa: ${free}`}. Spusť postavu ze zálohy níže.` : 'Všechna místa jsou obsazená. Další postavu spustíš tlačítkem Vyměnit v záloze.';
  let html;
  if (!active.length) html = `<p class="empty-note">Žádná postava neběží. ${dashboard.characters.length ? 'Spusť ji ze zálohy níže.' : 'Přidej postavu tlačítkem + Přidat postavu nebo ze seznamu postav účtu.'}</p>`;
  else if (activeView === 'cards') html = active.map(c => characterCard(c, sessions.get(c.id))).join('') + Array.from({ length: free }, () => '<div class="empty-slot-card"><strong>Volné místo</strong><small>Spusť postavu ze zálohy níže.</small></div>').join('');
  else html = `<div class="table-wrap"><table class="party-table roster-table"><thead><tr><th>Postava</th><th>Server</th><th>Mapa</th><th>HP · MP</th><th>XP/h</th><th>Gold/h</th><th>Gold</th><th>CODE</th><th><span class="sr-only">Akce</span></th></tr></thead><tbody>${active.map(c => activeRow(c, sessions.get(c.id))).join('')}</tbody></table></div><p class="fine">${freeText}</p>`;
  setHtml($('characters'), html);
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  activeView = button.dataset.view;
  try { localStorage.setItem(VIEW_KEY, activeView); } catch { /* Storage may be unavailable. */ }
  render();
});

// Reserve: saved characters that are not running, then the account's characters not yet in the panel.
let visibleReserve = [];
const ago = at => { const ms = (app.dashboard.now || Date.now()) - at; return ms < 60_000 ? 'právě teď' : `před ${duration(ms)}`; };
function setOptions(select, values, all) {
  const current = select.value;
  setHtml(select, `<option value="">${all}</option>${values.map(v => `<option value="${escape(v)}">${escape(v)}</option>`).join('')}`);
  select.value = values.includes(current) ? current : '';
}
function reserveRow(c, index, count, free) {
  const { dashboard } = app;
  const busy = pending.has(c.id), owned = ownedOf(c), script = dashboard.scripts.find(s => s.id === c.scriptId), seen = dashboard.lastSeen?.[c.id];
  const start = free
    ? `<button class="primary small-button" data-action="start" data-id="${c.id}" ${busy || !dashboard.config.authConfigured ? 'disabled' : ''}>${busy ? 'Pracuji…' : '▶ Start'}</button>`
    : `<button class="ghost small-button" data-action="swap" data-id="${c.id}" ${busy || !dashboard.config.authConfigured ? 'disabled' : ''} title="Zastavit jinou postavu a spustit tuto">⇄ Vyměnit</button>`;
  return `<tr>
    <td><div class="roster-name"><span class="order-buttons"><button class="ghost icon-button" data-action="up" data-id="${c.id}" ${index === 0 ? 'disabled' : ''} aria-label="Posunout ${escape(c.name)} výš">↑</button><button class="ghost icon-button" data-action="down" data-id="${c.id}" ${index === count - 1 ? 'disabled' : ''} aria-label="Posunout ${escape(c.name)} níž">↓</button></span><div><strong>${escape(c.name)}</strong><small>${escape(owned?.class || '—')}${owned?.level ? ` · ${number(owned.level)}` : ''}${owned?.online ? ' · online jinde' : ''}</small></div></div></td>
    <td>${escape(c.region)} ${escape(c.server)}</td>
    <td>${script ? escape(script.name) : '<span class="muted">výchozí CODE</span>'}</td>
    <td><label class="check"><input type="checkbox" data-autostart="${c.id}" ${c.autoStart ? 'checked' : ''} ${busy ? 'disabled' : ''}><span class="sr-only">Autostart ${escape(c.name)}</span></label></td>
    <td>${seen ? `<span title="${new Date(seen).toLocaleString('cs-CZ')}">${ago(seen)}</span>` : '<span class="muted">zatím ne</span>'}</td>
    <td><div class="roster-actions">${start}<button class="ghost small-button" data-action="edit" data-id="${c.id}" ${busy ? 'disabled' : ''}>Nastavení</button><button class="ghost danger small-button" data-action="delete" data-id="${c.id}" ${busy ? 'disabled' : ''}>Smazat</button></div></td>
  </tr>`;
}
function ownedRow({ owned, index }) {
  return `<tr class="roster-owned">
    <td><div class="roster-name"><span class="order-buttons" aria-hidden="true"></span><div><strong>${escape(owned.name)}</strong><small>${escape(owned.class || '—')}${owned.level ? ` · ${number(owned.level)}` : ''}${owned.online ? ' · online' : ''}</small></div></div><span class="tag">MIMO PANEL</span></td>
    <td>${owned.region ? `${escape(owned.region)} ${escape(owned.server)}` : '—'}</td>
    <td>${owned.codeSlot ? '<span class="muted">má výchozí CODE</span>' : '—'}</td>
    <td>—</td><td>—</td>
    <td><div class="roster-actions"><button class="ghost small-button" data-owned-index="${index}">+ Přidat do panelu</button></div></td>
  </tr>`;
}
function renderReserve() {
  const { dashboard } = app;
  if (!dashboard) return;
  const running = new Set(dashboard.sessions.map(s => s.id)), free = Math.max(0, dashboard.config.maxCharacters - running.size);
  const stopped = dashboard.characters.filter(c => !running.has(c.id));
  const saved = new Set(dashboard.characters.map(c => c.name.toLowerCase()));
  const missing = app.owned.map((owned, index) => ({ owned, index })).filter(({ owned }) => !saved.has(owned.name.toLowerCase()));
  setOptions($('reserve-class'), [...new Set([...stopped.map(c => ownedOf(c)?.class), ...missing.map(m => m.owned.class)].filter(Boolean))].sort(), 'Všechny třídy');
  setOptions($('reserve-server'), [...new Set([...stopped.map(c => `${c.region} ${c.server}`), ...missing.filter(m => m.owned.region).map(m => `${m.owned.region} ${m.owned.server}`)])].sort(), 'Všechny servery');
  const query = $('reserve-filter').value.trim().toLowerCase(), klass = $('reserve-class').value, server = $('reserve-server').value;
  const matches = (name, ctype, realm) => (!query || name.toLowerCase().includes(query)) && (!klass || ctype === klass) && (!server || realm === server);
  const shown = stopped.filter(c => matches(c.name, ownedOf(c)?.class, `${c.region} ${c.server}`));
  const shownMissing = missing.filter(m => matches(m.owned.name, m.owned.class, m.owned.region ? `${m.owned.region} ${m.owned.server}` : ''));
  visibleReserve = shown.map(c => c.id);
  $('reserve-count').textContent = `${stopped.length}${missing.length ? ` · ${missing.length} v účtu mimo panel` : ''}`;
  $('add-all-owned').hidden = !missing.length;
  $('add-all-owned').disabled = dashboard.characters.length >= dashboard.config.maxSaved;
  let html;
  if (!dashboard.characters.length && !missing.length) html = '<div class="empty"><h2>Tvůj tým začíná tady.</h2><p>Přidej postavu, přiřaď jí herní CODE slot a spusť ji. S API tokenem se tu ukážou všechny postavy účtu.</p></div>';
  else if (!shown.length && !shownMissing.length) html = `<p class="empty-note">${stopped.length || missing.length ? 'Žádná postava neodpovídá filtru.' : 'Všechny uložené postavy běží.'}</p>`;
  else html = `<div class="table-wrap"><table class="party-table roster-table"><thead><tr><th>Postava</th><th>Server</th><th>CODE</th><th>Autostart</th><th>Naposledy běžela</th><th><span class="sr-only">Akce</span></th></tr></thead><tbody>${shown.map((c, index) => reserveRow(c, index, shown.length, free)).join('')}${shownMissing.map(ownedRow).join('')}</tbody></table></div>`;
  setHtml($('reserve'), html);
}

// Party overview: parties of running characters, servers and distances between own characters.
let mapTitles = null;
const mapTitle = name => mapTitles?.get(name) || name;
const distance = (a, b) => a && b && a.map && a.map === b.map && Number.isFinite(a.x) && Number.isFinite(b.x) ? Math.round(Math.hypot(a.x - b.x, a.y - b.y)) : null;
const distanceText = (a, b) => { const d = distance(a, b); return d !== null ? `${number(d)} px` : a?.map && b?.map ? 'jiná mapa' : '—'; };
function renderParty() {
  const { dashboard } = app;
  const running = runningSessions();
  if (!running.length) { $('party-panel').hidden = true; return; }
  $('party-panel').hidden = false;
  if (!mapTitles) mapList().then(list => { mapTitles = new Map(list.map(m => [m.name, m.title])); renderParty(); }, () => { mapTitles = new Map(); });
  const config = id => dashboard.characters.find(c => c.id === id);
  const own = new Map(running.map(s => [s.state.name?.toLowerCase(), s]));
  const servers = new Map();
  for (const s of running) { const c = config(s.id), key = `${c.region} ${c.server}`; servers.set(key, [...(servers.get(key) || []), c.name]); }
  const parts = [];
  if (servers.size > 1) parts.push(`<p class="notice">Postavy běží na různých serverech: ${[...servers].map(([server, names]) => `<b>${escape(server)}</b> (${escape(names.join(', '))})`).join(' · ')}. Party a CODE zprávy fungují jen na stejném serveru.</p>`);
  const parties = new Map();
  for (const s of running) if (s.state.party) { const key = s.state.party.leader.toLowerCase(); if (!parties.has(key)) parties.set(key, s); }
  for (const s of parties.values()) {
    const party = s.state.party, server = `${config(s.id).region} ${config(s.id).server}`;
    const position = name => { const live = own.get(name.toLowerCase())?.state; return live ? { map: live.map, x: live.x, y: live.y } : party.members.find(m => m.name === name) || null; };
    const leader = position(party.leader);
    const rows = party.members.map(m => {
      const p = position(m.name), mine = own.get(m.name.toLowerCase());
      return `<tr><td><strong>${escape(m.name)}</strong>${m.name === party.leader ? ' <span class="tag slot">LEADER</span>' : ''}${mine ? ' <span class="tag">PANEL</span>' : ''}</td><td>${escape(m.ctype || mine?.state.ctype || '—')} ${m.level ? `· ${number(m.level)}` : ''}</td><td>${escape(server)}</td><td>${escape(p?.map ? mapTitle(p.map) : '—')}</td><td>${m.name === party.leader ? '—' : escape(distanceText(p, leader))}</td></tr>`;
    }).join('');
    parts.push(`<h3 class="inventory-section">Party · leader ${escape(party.leader)} <small>${party.members.length} členů</small></h3><div class="table-wrap"><table class="party-table"><thead><tr><th>Postava</th><th>Třída · LVL</th><th>Server</th><th>Mapa</th><th>Od leadera</th></tr></thead><tbody>${rows}</tbody></table></div>`);
  }
  const solo = running.filter(s => !s.state.party).map(s => s.state.name);
  if (solo.length) parts.push(`<p class="fine">Bez party: ${escape(solo.join(', '))}</p>`);
  if (running.length > 1) {
    const pairs = [];
    for (let i = 0; i < running.length; i++) for (let j = i + 1; j < running.length; j++) {
      const a = running[i], b = running[j], ca = config(a.id), cb = config(b.id);
      const sameServer = ca.region === cb.region && ca.server === cb.server;
      pairs.push(`<span class="meta-chip ${sameServer ? '' : 'draft'}">${escape(a.state.name)} ↔ ${escape(b.state.name)}: ${sameServer ? escape(distanceText(a.state, b.state)) : 'jiný server'}</span>`);
    }
    parts.push(`<h3 class="inventory-section">Vzdálenosti postav v panelu</h3><div class="editing-meta">${pairs.join('')}</div>`);
  }
  setHtml($('party-body'), parts.join('') || '<p class="fine">Žádná běžící postava není v partě.</p>');
}
function render() {
  const { dashboard } = app;
  if (!dashboard) return;
  const sessions = new Map(dashboard.sessions.map(s => [s.id, s]));
  const running = dashboard.sessions.filter(s => s.status === 'running');
  const free = Math.max(0, dashboard.config.maxCharacters - dashboard.sessions.length);
  $('stat-online').innerHTML = `${dashboard.sessions.length}<span>/ ${dashboard.config.maxCharacters}</span>`;
  $('stat-saved').textContent = `${number(dashboard.characters.length)} uloženo`;
  $('stat-scripts').textContent = dashboard.scripts.length;
  $('stat-gold').textContent = running.some(s => s.state) ? number(running.reduce((sum, s) => sum + (s.state?.gold || 0), 0)) : '—';
  $('stat-status').textContent = dashboard.sessions.some(s => s.status === 'reconnecting') ? 'Obnovuji' : running.length ? 'Online' : 'Připraveno';
  $('last-update').textContent = `Aktualizováno ${new Date().toLocaleTimeString('cs-CZ')}`;
  $('auth-warning').hidden = dashboard.config.authConfigured;
  renderSetup();
  const account = dashboard.account;
  $('account-status').textContent = account?.configured ? (account.email ? `Přihlášen: ${account.email}` : 'Herní relace je připravena; ověří se při spuštění postavy.') : 'Účet není připojen';
  $('manage-account').textContent = account?.configured ? 'Spravovat účet' : 'Připojit účet';
  $('api-status').textContent = `Uložené postavy, které neběží. Pořadí šipkami určuje, které se spustí první (autostart, Spustit vše).${dashboard.gameApi?.configured ? '' : ' Připoj API token, aby se ukázala třída, level a ostatní postavy účtu.'}`;
  $('load-owned').disabled = !dashboard.gameApi?.configured;
  $('add-character').disabled = dashboard.characters.length >= dashboard.config.maxSaved;
  if (Number.isFinite(dashboard.now)) clockOffset = Date.now() - dashboard.now;
  renderActive(sessions, free);
  const stopped = dashboard.characters.filter(c => !sessions.has(c.id));
  $('start-all').disabled = !stopped.length || !free || !dashboard.config.authConfigured || pending.has('batch');
  $('start-all').title = free ? 'Spustit zastavené postavy podle pořadí, dokud jsou volná místa' : 'Všechna místa jsou obsazená';
  $('stop-all').disabled = !dashboard.sessions.length || pending.has('batch');
  $('reload-all').disabled = !running.length || pending.has('batch');
  $('relog-all').disabled = !dashboard.sessions.length || !dashboard.config.authConfigured || pending.has('batch');
  $('move-all').disabled = !dashboard.characters.length || pending.has('batch');
  renderParty(); renderReserve();
}
on('dashboard', offline => {
  if (offline) { $('stat-status').textContent = 'Nedostupné'; $('last-update').textContent = 'Spojení s panelem bylo přerušeno'; return; }
  render(); ensureOwned();
});
on('owned', () => { if (app.dashboard) renderReserve(); });
on('reset', () => { for (const id of ['characters', 'reserve']) { $(id).replaceChildren(); delete $(id).dataset.html; } });
setInterval(() => {
  for (const element of document.querySelectorAll('[data-ready-at]')) {
    const left = Number(element.dataset.readyAt) - Date.now();
    element.textContent = left > 0 ? `${(left / 1000).toFixed(left < 10_000 ? 1 : 0)} s` : 'připraveno';
    element.classList.toggle('ready', left <= 0);
  }
}, 1000);
$('characters').addEventListener('toggle', event => {
  const key = event.target.dataset?.key; if (!key) return;
  if (event.target.open) openDetails.add(key); else openDetails.delete(key);
}, true);
$('manage-account').addEventListener('click', openAccount);

function openCharacter(character) {
  $('character-form').reset(); $('character-id').value = character?.id || ''; $('dialog-title').textContent = character?.id ? `Nastavení postavy ${character.name}` : 'Přidat postavu';
  $('character-name').value = character?.name || ''; $('character-region').value = character?.region || 'EU'; $('character-server').value = character?.server || 'I'; $('character-autostart').checked = character?.autoStart || false;
  $('character-idle').value = character?.idleMinutes ?? 10; $('character-auto-reload').checked = character?.autoReloadIdle || false; $('character-potions').value = character?.potionMin ?? 10;
  $('character-script').innerHTML = scriptOptions(character?.scriptId || '', 'Vždy výchozí CODE postavy (poslední verze)', true);
  const scriptHint = () => { $('character-script-hint').textContent = $('character-script').value ? 'Před každým startem i reconnectem se stáhne poslední verze vybraného herního slotu.' : 'Při každém startu, restartu i reconnectu se ve hře najde aktuální výchozí CODE slot postavy a stáhne se jeho poslední verze. Výběr zůstane automatický. Vyžaduje API token.'; };
  $('character-script').onchange = scriptHint; scriptHint();
  $('character-dialog').showModal();
}
$('add-character').addEventListener('click', () => openCharacter()); $('close-dialog').addEventListener('click', () => $('character-dialog').close());
$('character-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  const id = $('character-id').value;
  try {
    await api(`/characters${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { name: $('character-name').value, region: $('character-region').value, server: $('character-server').value, scriptId: $('character-script').value || null, autoStart: $('character-autostart').checked, idleMinutes: Number($('character-idle').value), autoReloadIdle: $('character-auto-reload').checked, potionMin: Number($('character-potions').value) });
    $('character-dialog').close(); toast('Postava uložena.'); await refresh();
  } catch (error) { toast(error.message, true); }
  finally { event.submitter.disabled = false; }
});
async function characterAction(event) {
  const button = event.target.closest('button[data-action]'); if (!button) return;
  const { id, action } = button.dataset;
  if (action === 'expand') { if (!expanded.delete(id)) expanded.add(id); return render(); }
  if (action === 'swap') return openSwap(id);
  if (action === 'up' || action === 'down') return reorder(id, action === 'up' ? -1 : 1);
  if (action === 'transfer') return openTransfer(id);
  if (action === 'storage') return openStorage(id);
  if (action === 'edit') return openCharacter(app.dashboard.characters.find(c => c.id === id));
  if (action === 'delete' && !confirm('Smazat tuto postavu z panelu?')) return;
  pending.add(id); render();
  try { await api(`/characters/${id}${action === 'delete' ? '' : `/${action}`}`, action === 'delete' ? 'DELETE' : 'POST', {}); toast(action === 'start' ? 'CODE stažen, postava se připojuje. Stav uvidíš mezi aktivními postavami.' : 'Hotovo.'); }
  catch (error) { toast(error.message, true); }
  finally { pending.delete(id); await refresh(); }
}
$('characters').addEventListener('click', characterAction);
$('reserve').addEventListener('click', characterAction);
$('setup-steps').addEventListener('click', event => {
  const action = event.target.closest('[data-setup-action]')?.dataset.setupAction;
  if (action === 'account') openAccount();
  if (action === 'token') { openAccount(); $('token-option').open = true; $('api-token').focus(); }
  if (action === 'editor') location.href = '/editor';
  if (action === 'add') openCharacter();
});

$('load-owned').addEventListener('click', async () => {
  $('load-owned').disabled = true;
  try { await loadOwned(); }
  catch (error) { toast(error.message, true); }
  finally { $('load-owned').disabled = !app.dashboard.gameApi?.configured; }
});
$('reserve').addEventListener('click', event => {
  const button = event.target.closest('[data-owned-index]');
  if (!button) return;
  const owned = app.owned[Number(button.dataset.ownedIndex)];
  // New characters use their default slot, looked up again at every start.
  openCharacter({ name: owned.name, region: owned.region || 'EU', server: owned.server || 'I', scriptId: null });
});
// Autostart is switched right in the reserve list; the rest of the settings stay as saved.
$('reserve').addEventListener('change', async event => {
  const input = event.target.closest('input[data-autostart]'); if (!input) return;
  const character = app.dashboard.characters.find(c => c.id === input.dataset.autostart);
  if (!character) return;
  const { id, controls, ...settings } = character;
  pending.add(id); input.disabled = true;
  try { await api(`/characters/${id}`, 'PUT', { ...settings, autoStart: input.checked }); toast(`${character.name}: autostart ${input.checked ? 'zapnut' : 'vypnut'}.`); }
  catch (error) { toast(error.message, true); }
  finally { pending.delete(id); await refresh(); }
});
$('add-all-owned').addEventListener('click', async () => {
  const saved = new Set(app.dashboard.characters.map(c => c.name.toLowerCase()));
  const missing = app.owned.filter(o => !saved.has(o.name.toLowerCase()));
  if (!missing.length || !confirm(`Přidat do panelu ${missing.length} ${missing.length === 1 ? 'postavu' : missing.length <= 4 ? 'postavy' : 'postav'} z herního účtu? Dostanou server z účtu a výchozí CODE postavy; nastavení lze později změnit.`)) return;
  $('add-all-owned').disabled = true;
  let added = 0;
  try {
    for (const owned of missing) { await api('/characters', 'POST', { name: owned.name, region: owned.region || 'EU', server: owned.server || 'I', scriptId: null }); added++; }
    toast(`Přidáno ${number(added)} postav.`);
  } catch (error) { toast(`Přidáno ${number(added)} postav. ${error.message}`, true); }
  finally { $('add-all-owned').disabled = false; await refresh(); }
});
for (const id of ['reserve-filter', 'reserve-class', 'reserve-server']) $(id).addEventListener('input', () => renderReserve());

// Swapping a stopped character for a running one when every place is taken
let swapCharacterId = '';
function openSwap(id) {
  swapCharacterId = id;
  $('swap-title').textContent = `Spustit ${characterName(id)} místo…`;
  $('swap-options').innerHTML = app.dashboard.sessions.map(s => {
    const c = app.dashboard.characters.find(c => c.id === s.id);
    return c ? `<button class="ghost" data-replace="${c.id}">■ Zastavit <strong>${escape(c.name)}</strong> <small class="muted">${escape(c.region)} ${escape(c.server)}${s.state ? ` · ${escape(mapTitle(s.state.map))}` : ''} · ${statusLabel(s.status, s.state?.rip)}</small></button>` : '';
  }).join('') || '<p class="empty-note">Žádná postava neběží, můžeš ji rovnou spustit.</p>';
  $('swap-dialog').showModal();
}
$('close-swap').addEventListener('click', () => $('swap-dialog').close());
$('swap-options').addEventListener('click', async event => {
  const button = event.target.closest('button[data-replace]'); if (!button) return;
  const id = swapCharacterId, replace = button.dataset.replace;
  $('swap-dialog').close(); pending.add(id); pending.add(replace); render();
  try { await api(`/characters/${id}/swap`, 'POST', { replace }); toast(`${characterName(replace)} zastavena, ${characterName(id)} se připojuje.`); }
  catch (error) { toast(error.message, true); }
  finally { pending.delete(id); pending.delete(replace); await refresh(); }
});
// Moves a character before or after its neighbour in the reserve list as shown (filters included).
async function reorder(id, step) {
  const index = visibleReserve.indexOf(id), other = visibleReserve[index + step];
  if (index < 0 || !other) return;
  const ids = app.dashboard.characters.map(c => c.id), a = ids.indexOf(id), b = ids.indexOf(other);
  [ids[a], ids[b]] = [ids[b], ids[a]];
  try { await api('/characters/order', 'PUT', { ids }); }
  catch (error) { toast(error.message, true); }
  finally { await refresh(); }
}

// Transfers
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
    const recipients = new Set([...app.owned.map(c => c.name), ...app.dashboard.characters.map(c => c.name)]);
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

// Values the character's CODE stored with set()
let storageCharacterId = '', storageData = null, storageEditing = null, storageDraft = '';
function renderStorage() {
  if (!storageData) return;
  const filter = $('storage-filter').value.trim().toLowerCase();
  const shown = storageData.entries.filter(e => e.key === storageEditing || !filter || e.key.toLowerCase().includes(filter) || e.value.toLowerCase().includes(filter));
  const bytes = value => value < 1024 ? `${number(value)} B` : `${(value / 1024).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} kB`;
  const limited = storageData.total > storageData.entries.length ? ` · zobrazeno prvních ${number(storageData.entries.length)}` : '';
  $('storage-from').textContent = `${characterName(storageCharacterId)} · ${number(storageData.total)} ${storageData.total === 1 ? 'hodnota' : storageData.total >= 2 && storageData.total <= 4 ? 'hodnoty' : 'hodnot'} · ${bytes(storageData.size)}${limited} · načteno ${new Date(storageData.observedAt).toLocaleTimeString('cs-CZ')}`;
  $('clear-storage').disabled = !storageData.total;
  if (!storageData.entries.length) { $('storage-list').innerHTML = '<p class="empty-note">CODE zatím nic neuložil. Hodnoty vzniknou voláním <code>set("klíč", hodnota)</code>.</p>'; return; }
  if (!shown.length) { $('storage-list').innerHTML = '<p class="empty-note">Žádná hodnota neodpovídá hledání.</p>'; return; }
  const body = e => e.key === storageEditing
    ? `<textarea class="storage-editor" spellcheck="false" aria-label="Hodnota ${escape(e.key)} jako JSON">${escape(storageDraft)}</textarea><div class="storage-actions"><span class="fine">JSON — text v uvozovkách, číslo, true/false, null, pole nebo objekt.</span><button class="ghost small-button" data-storage="cancel">Zrušit</button><button class="primary small-button" data-storage="save" data-key="${escape(e.key)}">Uložit</button></div>`
    : `<pre>${escape(e.value)}${e.truncated ? '\n…zkráceno' : ''}</pre><div class="storage-actions"><span class="fine">${!e.deletable ? 'Klíč nelze upravit ani smazat (zkrácený nebo skrytý).' : !e.editable ? 'Hodnotu nelze upravit (zkrácená nebo obsahuje skrytý údaj).' : ''}</span><button class="ghost small-button" data-storage="edit" data-key="${escape(e.key)}" ${e.editable && !storageEditing ? '' : 'disabled'}>Upravit</button><button class="ghost danger small-button" data-storage="delete" data-key="${escape(e.key)}" ${e.deletable ? '' : 'disabled'}>Smazat</button></div>`;
  $('storage-list').innerHTML = shown.map(e => `<details class="storage-entry" ${shown.length <= 8 || e.key === storageEditing ? 'open' : ''}><summary><code>${escape(e.key)}</code><small>${bytes(e.size)}${e.valid ? '' : ' · neplatný JSON'}</small></summary>${body(e)}</details>`).join('');
}
async function openStorage(id) {
  try {
    const data = await api(`/characters/${id}/storage`);
    if (storageCharacterId !== id) { $('storage-filter').value = ''; storageEditing = null; }
    storageCharacterId = id; storageData = data; $('storage-error').textContent = '';
    // A value being edited keeps its draft across refreshes; it is dropped once CODE removed the key.
    if (storageEditing && !data.entries.some(e => e.key === storageEditing && e.editable)) storageEditing = null;
    renderStorage(); if (!$('storage-dialog').open) $('storage-dialog').showModal();
  } catch (error) { if ($('storage-dialog').open) $('storage-error').textContent = error.message; else toast(error.message, true); }
}
const storageUrl = key => `/characters/${storageCharacterId}/storage${key === undefined ? '' : `/${encodeURIComponent(key)}`}`;
$('storage-list').addEventListener('input', event => { if (event.target.matches('.storage-editor')) storageDraft = event.target.value; });
$('storage-list').addEventListener('click', async event => {
  const button = event.target.closest('button[data-storage]'); if (!button) return;
  const { storage: action, key } = button.dataset;
  $('storage-error').textContent = '';
  if (action === 'edit') { storageEditing = key; storageDraft = storageData.entries.find(e => e.key === key)?.value ?? ''; renderStorage(); return $('storage-list').querySelector('.storage-editor')?.focus(); }
  if (action === 'cancel') { storageEditing = null; return renderStorage(); }
  if (action === 'save') {
    try { JSON.parse(storageDraft); } catch (error) { $('storage-error').textContent = `Neplatný JSON: ${error.message}`; return; }
    button.disabled = true;
    try { await api(storageUrl(key), 'PUT', { value: storageDraft }); storageEditing = null; toast(`Hodnota ${key} uložena.`); await openStorage(storageCharacterId); }
    catch (error) { $('storage-error').textContent = error.message; button.disabled = false; }
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Smazat uloženou hodnotu „${key}“? CODE ji pak přes get() dostane jako null.`)) return;
    button.disabled = true;
    try { await api(storageUrl(key), 'DELETE', {}); if (storageEditing === key) storageEditing = null; toast(`Hodnota ${key} smazána.`); await openStorage(storageCharacterId); }
    catch (error) { $('storage-error').textContent = error.message; button.disabled = false; }
  }
});
$('clear-storage').addEventListener('click', async () => {
  if (!confirm(`Smazat všechny hodnoty uložené CODE postavy ${characterName(storageCharacterId)}? Nelze vrátit.`)) return;
  $('clear-storage').disabled = true;
  try { const { removed } = await api(storageUrl(), 'DELETE', {}); storageEditing = null; toast(`Smazáno ${number(removed)} ${removed === 1 ? 'hodnota' : removed >= 2 && removed <= 4 ? 'hodnoty' : 'hodnot'}.`); await openStorage(storageCharacterId); }
  catch (error) { $('storage-error').textContent = error.message; renderStorage(); }
});
$('close-storage').addEventListener('click', () => $('storage-dialog').close());
$('storage-dialog').addEventListener('close', () => { storageEditing = null; });
$('storage-filter').addEventListener('input', renderStorage);
$('reload-storage').addEventListener('click', async () => {
  $('reload-storage').disabled = true;
  try { await openStorage(storageCharacterId); } finally { $('reload-storage').disabled = false; }
});

// Batch actions
async function batch(body, label) {
  pending.add('batch'); render();
  try {
    const { results } = await api('/characters/batch', 'POST', body);
    const failed = results.filter(r => !r.ok);
    if (failed.length) toast(`${label}: ${failed.map(r => `${r.name} – ${r.error}`).join(' · ')}`, true);
    else {
      const full = results.filter(r => r.note);
      toast(`${label}: hotovo (${results.filter(r => !r.skipped).length}).${full.length ? ` Bez volného místa: ${full.map(r => r.name).join(', ')}.` : ''}`);
    }
  } catch (error) { toast(error.message, true); }
  finally { pending.delete('batch'); await refresh(); }
}
$('start-all').addEventListener('click', () => batch({ action: 'start' }, 'Spuštění všech'));
$('stop-all').addEventListener('click', () => { if (confirm('Zastavit všechny běžící postavy? Vypne se i jejich autostart.')) batch({ action: 'stop' }, 'Zastavení všech'); });
$('reload-all').addEventListener('click', () => batch({ action: 'reload' }, 'Restart CODE'));
$('relog-all').addEventListener('click', () => { if (confirm('Odhlásit a znovu přihlásit všechny běžící postavy?')) batch({ action: 'relog' }, 'Relog všech'); });
$('move-all').addEventListener('click', () => {
  const first = app.dashboard.characters[0];
  $('move-region').value = first?.region || 'EU'; $('move-server').value = first?.server || 'I';
  $('move-characters').innerHTML = app.dashboard.characters.map(c => `<label class="check"><input type="checkbox" value="${c.id}" ${app.dashboard.sessions.some(s => s.id === c.id) ? 'checked' : ''}>${escape(c.name)} <small class="muted">${escape(c.region)} ${escape(c.server)}${isRunning(c.id) ? ' · běží' : ''}</small></label>`).join('');
  $('move-dialog').showModal();
});
$('close-move').addEventListener('click', () => $('move-dialog').close());
$('move-form').addEventListener('submit', event => {
  event.preventDefault();
  const ids = [...$('move-characters').querySelectorAll('input:checked')].map(input => input.value);
  if (!ids.length) return toast('Vyber alespoň jednu postavu.', true);
  $('move-dialog').close();
  batch({ action: 'move', ids, region: $('move-region').value, server: $('move-server').value }, `Přesun na ${$('move-region').value} ${$('move-server').value}`);
});

await boot();
