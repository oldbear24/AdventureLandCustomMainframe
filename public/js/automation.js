// Automation page: what each character's CODE offers to set, what it reports doing, remembered values and commands.
import { $, api, app, boot, classColors, duration, escape, number, on, percentage, signed, toast } from './core.js';

let data = null, targets = null, loading = false, loadedAt = 0, requested = new URLSearchParams(location.search).get('character');
// Text typed into a field survives the 5 s refresh until it is submitted.
const drafts = new Map(), shown = new WeakMap();
const draftKey = (id, key, field) => `${id}|${key}|${field}`;
const FALLBACK_LABELS = { primary: 'Hlavní cíl farmení', dungeons: 'Dungeonové výpravy' };
const labelOf = (character, key) => character.live?.controls.find(c => c.key === key)?.label || FALLBACK_LABELS[key] || (key.startsWith('module.') ? `Modul ${key.slice(7)}` : key);
const targetName = key => targets?.names.get(key) || key;
const formatValue = value => typeof value === 'boolean' ? (value ? 'zapnuto' : 'vypnuto')
  : value && typeof value === 'object' ? (value.target ? `${targetName(value.target)}${value.goal ? ` ×${number(value.goal)}` : ''}` : 'žádný cíl') : String(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const time = at => Number.isFinite(at) ? new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const chance = value => !Number.isFinite(value) || value <= 0 ? '' : value >= 1 ? '100 %' : `${Number((value * 100).toPrecision(2)).toLocaleString('cs-CZ')} %`;
const MODES = { work: ['⚔', 'Pracuje'], home: ['⌂', 'Doma'], dead: ['☠', 'Mrtvá'], idle: ['…', 'Čeká'] };
const STATUS = { running: 'ONLINE', starting: 'STARTUJI', reconnecting: 'OBNOVUJI', stopped: 'OFFLINE' };

async function load() {
  if (loading || !app.active) return;
  loading = true;
  try {
    data = await api('/automation'); loadedAt = Date.now();
    const wanted = data.characters.some(c => c.live?.controls.some(control => ['target', 'item', 'monster'].includes(control.type)));
    if (wanted && !targets) loadTargets();
    render();
  } catch (error) { $('automation-updated').textContent = `Načtení selhalo: ${error.message}`; }
  finally { loading = false; }
}
async function loadTargets() {
  targets = { names: new Map() };
  try {
    const list = await api('/targets');
    const options = [...list.items.map(i => [i.key, i.name, 'předmět']), ...list.monsters.map(m => [m.key, m.name, 'příšera'])];
    for (const [key, name] of options) targets.names.set(key, name);
    $('automation-targets').innerHTML = options.map(([key, name, kind]) => `<option value="${escape(key)}">${escape(name)} · ${kind}</option>`).join('');
    render();
  } catch { /* Fields still accept exact keys and names without suggestions. */ }
}

// A part is redrawn only when its content changed and nobody is typing in it.
function setPart(element, html) {
  if (shown.get(element) === html) return;
  const active = document.activeElement;
  if (element.contains(active) && active.matches('input:not([type=checkbox]), select, textarea')) return;
  element.innerHTML = html; shown.set(element, html);
}
function render() {
  const root = $('automation');
  if (!data || !app.dashboard) return;
  $('automation-updated').textContent = `Aktualizováno ${time(loadedAt)}`;
  if (!data.characters.length) { root.innerHTML = '<p class="empty-note">Zatím žádné postavy. Přidej je na stránce <a href="/">Postavy</a>.</p>'; return; }
  root.querySelector(':scope > .empty-note')?.remove();
  const ids = new Set(data.characters.map(c => c.id));
  for (const card of root.querySelectorAll('[data-card]')) if (!ids.has(card.dataset.card)) card.remove();
  for (const character of data.characters) {
    let card = root.querySelector(`[data-card="${CSS.escape(character.id)}"]`);
    if (!card) {
      card = document.createElement('article'); card.className = 'automation-card'; card.dataset.card = character.id;
      card.innerHTML = '<div class="auto-head"></div><div class="auto-activity"></div><div class="auto-controls"></div><div class="auto-saved"></div>';
    }
    root.appendChild(card);
    const session = app.dashboard.sessions.find(s => s.id === character.id);
    card.classList.toggle('is-running', character.status === 'running');
    setPart(card.querySelector('.auto-head'), headHtml(character, session));
    setPart(card.querySelector('.auto-activity'), activityHtml(character, session));
    setPart(card.querySelector('.auto-controls'), controlsHtml(character));
    setPart(card.querySelector('.auto-saved'), savedHtml(character));
  }
  if (requested && ids.has(requested)) {
    const card = root.querySelector(`[data-card="${CSS.escape(requested)}"]`);
    card.classList.add('highlight'); card.scrollIntoView({ block: 'start' }); requested = null;
  }
}

function headHtml(character, session) {
  const state = session?.state, color = classColors[state?.ctype] || 'var(--accent)';
  const config = app.dashboard.characters.find(c => c.id === character.id);
  const dead = character.status === 'running' && state?.rip;
  return `<div class="card-head"><div class="character-title"><div class="avatar" style="color:${color}">${escape(character.name.slice(0, 1).toUpperCase())}</div><div><h3>${escape(character.name)}</h3><small>${state ? `LVL ${state.level} ${escape(state.ctype)} · ` : ''}${escape(config?.region || '')} ${escape(config?.server || '')}</small></div></div><span class="badge ${dead ? 'dead' : character.status}">${dead ? 'DEAD' : STATUS[character.status] || character.status}</span></div>`;
}

function activityHtml(character, session) {
  if (character.status !== 'running') return `<p class="empty-note">Postava neběží. Spusť ji na stránce <a href="/">Postavy</a>; zapamatovaná nastavení se po připojení nastaví sama.</p>`;
  if (!character.live) return `<p class="empty-note">${escape(character.error || 'Čekám na běžící CODE…')}</p>`;
  const state = session?.state, activity = character.live.activity, stats = session?.stats;
  const modeKey = state?.rip ? 'dead' : MODES[activity?.mode] ? activity.mode : activity ? 'work' : 'idle';
  const [icon, modeLabel] = MODES[modeKey];
  const target = state?.target ? state.nearby?.find(e => e.id === state.target) : null;
  const plan = activity && (activity.current || activity.next)
    ? `<div class="auto-plan"><p><small>TEĎ</small><b>${escape(activity.current || '—')}</b></p>${activity.next ? `<p class="auto-next"><small>DÁL</small><span>${escape(activity.next)}</span></p>` : ''}</div>`
    : `<div class="auto-plan"><p><small>TEĎ</small><b>${state?.rip ? 'Mrtvá; čeká na oživení' : target ? `Boj: ${escape(target.name)}` : state?.codeRunning ? 'CODE běží' : 'CODE stojí'}</b></p><p class="auto-next"><span class="muted">CODE nehlásí plán (viz nápověda dole).</span></p></div>`;
  const vitals = state ? `<div class="auto-vitals"><div><div class="meter-label"><span>HP</span><span>${number(state.hp)} / ${number(state.max_hp)}</span></div><div class="meter"><i style="--fill:${percentage(state.hp, state.max_hp)}%"></i></div></div><div><div class="meter-label"><span>MP</span><span>${number(state.mp)} / ${number(state.max_mp)}</span></div><div class="meter mp"><i style="--fill:${percentage(state.mp, state.max_mp)}%"></i></div></div></div>` : '';
  const facts = [
    state?.map && `<span title="Mapa">◈ ${escape(state.map)}</span>`,
    target && `<span title="Cíl útoku">⌖ ${escape(target.name)}</span>`,
    activity?.leader && `<span title="Vedoucí skupiny">⚑ ${escape(activity.leader)}</span>`,
    stats?.xpPerHour !== null && stats?.xpPerHour !== undefined && `<span title="XP za hodinu">XP/h ${number(stats.xpPerHour)}</span>`,
    stats?.goldPerHour !== null && stats?.goldPerHour !== undefined && `<span title="Zlato za hodinu">G/h ${signed(stats.goldPerHour)}</span>`,
    session?.idleMs >= 60_000 && `<span class="warn" title="Bez pohybu, útoku, XP i změny zlata">bez aktivity ${duration(session.idleMs)}</span>`,
  ].filter(Boolean).join('');
  const events = (activity?.events || []).slice(-8).reverse();
  const timeline = events.length ? `<ol class="auto-events" aria-label="Poslední události CODE">${events.map(e => `<li class="ev-${escape(e.status || 'info')}"><time>${time(e.at)}</time><span>${escape(e.text)}</span></li>`).join('')}</ol>` : '';
  const errors = character.live.errors?.length ? `<p class="fine warn">Část dat CODE nešla přečíst: ${escape(character.live.errors.join(' · '))}</p>` : '';
  return `<div class="auto-now mode-${modeKey}"><div class="auto-mode"><span aria-hidden="true">${icon}</span><small>${modeLabel}</small></div>${plan}</div>${vitals}${facts ? `<div class="auto-facts">${facts}</div>` : ''}${timeline}${errors}`;
}

function rememberBox(character, control) {
  const saved = Object.hasOwn(character.saved, control.key);
  const differs = saved && !same(character.saved[control.key], control.value);
  return `<label class="check auto-remember" title="Uložit hodnotu v panelu a nastavit ji znovu po každém připojení postavy"><input type="checkbox" data-remember="${escape(control.key)}" ${saved ? 'checked' : ''}>Pamatovat${differs ? ` <em>(uloženo: ${escape(formatValue(character.saved[control.key]))})</em>` : ''}</label>`;
}
function draft(character, control, field, value) {
  const key = draftKey(character.id, control.key, field);
  return drafts.has(key) ? drafts.get(key) : value;
}
function inputFor(character, control) {
  const field = (name, attributes, value) => `<input data-field="${name}" data-draft="${escape(draftKey(character.id, control.key, name))}" ${attributes} value="${escape(draft(character, control, name, value))}">`;
  if (control.type === 'boolean') return `<button type="button" class="switch ${control.value ? 'on' : ''}" role="switch" aria-checked="${control.value ? 'true' : 'false'}" data-toggle="${escape(control.key)}">${control.value ? 'Zapnuto' : 'Vypnuto'}</button>`;
  if (control.type === 'target') return `${field('target', 'list="automation-targets" maxlength="40" placeholder="předmět nebo příšera" aria-label="Cíl"', control.value?.target || '')}${field('goal', 'type="number" min="0" max="9999" step="1" placeholder="ks" class="auto-goal" aria-label="Počet kusů"', control.value?.goal || '')}<button class="primary small-button">Nastavit</button>${control.value?.target ? `<button type="button" class="ghost small-button" data-clear="${escape(control.key)}">Zrušit cíl</button>` : ''}`;
  if (control.type === 'select' && control.options) {
    const current = draft(character, control, 'value', control.value);
    return `<select data-field="value" data-draft="${escape(draftKey(character.id, control.key, 'value'))}" aria-label="${escape(control.label)}">${control.options.map(o => `<option ${o === current ? 'selected' : ''}>${escape(o)}</option>`).join('')}</select><button class="primary small-button">Nastavit</button>`;
  }
  if (control.type === 'number') return `${field('value', `type="number" step="any" ${control.min !== null ? `min="${control.min}"` : ''} ${control.max !== null ? `max="${control.max}"` : ''} aria-label="${escape(control.label)}"`, control.value ?? '')}<button class="primary small-button">Nastavit</button>`;
  const list = control.type === 'item' || control.type === 'monster' ? 'list="automation-targets"' : '';
  return `${field('value', `${list} maxlength="200" aria-label="${escape(control.label)}"`, control.value ?? '')}<button class="primary small-button">Nastavit</button>`;
}
function statusHtml(control) {
  const status = control.status;
  if (control.type === 'target') {
    const value = control.value || {};
    const current = value.target ? `<p class="auto-current">Teď: <b>${escape(targetName(value.target))}</b> <code>${escape(value.target)}</code>${value.goal ? ` · do ${number(value.goal)} ks` : ' · bez limitu'}${status?.by ? ` · zadala ${escape(status.by)}` : ''}</p>` : '<p class="auto-current">Teď: <b>žádný cíl</b> – tým si loviště vybírá sám.</p>';
    const sources = status?.sources?.length ? (() => {
      const best = Math.max(...status.sources.map(s => s.chance || 0));
      return `<ul class="auto-sources" aria-label="Zdroje cíle">${status.sources.map(s => `<li><span>${escape(s.name)}</span><i class="meter"><i style="--fill:${best > 0 ? Math.max(4, percentage(s.chance || 0, best)) : 100}%"></i></i><small>${escape([chance(s.chance), s.map || 'mimo povolené mapy'].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul>`;
    })() : '';
    return `${current}${status?.text ? `<p class="auto-status ${/^NELZE/.test(status.text) ? 'warn' : /^LOVÍ/.test(status.text) ? 'good' : ''}">${escape(status.text)}</p>` : ''}${sources}`;
  }
  return status?.text && control.type !== 'boolean' ? `<p class="auto-status">${escape(status.text)}</p>` : '';
}
function controlsHtml(character) {
  if (character.status !== 'running' || !character.live) return '';
  const { controls, commands } = character.live;
  const groups = new Map();
  for (const control of controls) groups.set(control.group, [...(groups.get(control.group) || []), control]);
  const rows = [...groups].map(([group, list]) => `<fieldset class="auto-group"><legend>${escape(group)}</legend>${list.map(control => {
    const note = control.type === 'boolean' ? control.status?.text || control.help : control.help;
    return `<form class="auto-row type-${escape(control.type)}" data-control="${escape(control.key)}"><div class="auto-label"><strong>${escape(control.label)}</strong>${note ? `<small>${escape(note)}</small>` : ''}</div><div class="auto-input">${inputFor(character, control)}</div>${rememberBox(character, control)}${statusHtml(control)}</form>`;
  }).join('')}</fieldset>`).join('');
  const empty = controls.length ? '' : '<p class="empty-note">CODE této postavy zatím nic k nastavení nenabízí. Jak to přidat, najdeš v nápovědě dole.</p>';
  const command = commands ? `<form class="auto-command" data-command><label for="command-${escape(character.id)}">Příkaz pro CODE</label><div class="auto-input"><input id="command-${escape(character.id)}" data-draft="${escape(draftKey(character.id, '', 'command'))}" value="${escape(drafts.get(draftKey(character.id, '', 'command')) || '')}" maxlength="241" placeholder="/cil spidersilk 2 · /home all · /farm all" autocomplete="off"><button class="ghost small-button">Spustit</button></div><small class="fine">Jako příkaz v herním chatu (volá handle_command tvého CODE), do chatu se nic neposílá.</small></form>` : '';
  return `${rows}${empty}${command}`;
}
function savedHtml(character) {
  const offered = new Set(character.status === 'running' ? (character.live?.controls || []).map(c => c.key) : []);
  const rest = Object.entries(character.saved).filter(([key]) => !offered.has(key));
  if (!rest.length) return '';
  const pending = new Set(character.pending);
  return `<div class="auto-group"><p class="auto-saved-title">Zapamatováno – nastaví se po připojení</p><ul class="auto-saved-list">${rest.map(([key, value]) => `<li><span>${escape(labelOf(character, key))}</span><b>${escape(formatValue(value))}</b>${pending.has(key) ? '<small>čeká, až ho CODE nabídne</small>' : ''}<button type="button" class="ghost small-button" data-forget="${escape(key)}">Zapomenout</button></li>`).join('')}</ul></div>`;
}

const characterOf = element => data?.characters.find(c => c.id === element.closest('[data-card]')?.dataset.card);
const controlOf = (character, key) => character?.live?.controls.find(c => c.key === key);
// Typed text is kept when only Pamatovat changes, so a value being written is not lost.
async function setControl(character, key, value, remember = Object.hasOwn(character.saved, key), keepDrafts = false) {
  const result = await api(`/characters/${character.id}/controls/${encodeURIComponent(key)}`, 'PUT', { value, remember });
  if (!keepDrafts) for (const field of ['target', 'goal', 'value']) drafts.delete(draftKey(character.id, key, field));
  toast(`${character.name}: ${labelOf(character, key)} = ${formatValue(result.value)}${remember ? ' (zapamatováno)' : ''}`);
  await load();
}
async function busy(element, action) {
  const buttons = [...element.querySelectorAll('button, input[type=checkbox]')];
  for (const button of buttons) button.disabled = true;
  try { await action(); } catch (error) { toast(error.message, true); }
  finally { for (const button of buttons) button.disabled = false; }
}
$('automation').addEventListener('input', event => {
  const key = event.target.dataset?.draft;
  if (key && event.target.type !== 'checkbox') drafts.set(key, event.target.value);
});
$('automation').addEventListener('change', event => {
  if (event.target.matches('select[data-draft]')) drafts.set(event.target.dataset.draft, event.target.value);
  const key = event.target.dataset?.remember;
  if (key === undefined) return;
  const character = characterOf(event.target), control = controlOf(character, key), wanted = event.target.checked;
  busy(event.target.closest('form'), async () => {
    if (wanted) await setControl(character, key, control.value, true, true);
    else { await api(`/characters/${character.id}/controls/${encodeURIComponent(key)}`, 'DELETE', {}); toast(`${character.name}: ${labelOf(character, key)} se už nepamatuje.`); await load(); }
  });
});
$('automation').addEventListener('click', event => {
  const button = event.target.closest('button[data-toggle], button[data-clear], button[data-forget]');
  if (!button) return;
  const character = characterOf(button);
  if (button.dataset.toggle) return busy(button.closest('form'), () => setControl(character, button.dataset.toggle, !controlOf(character, button.dataset.toggle).value));
  if (button.dataset.clear) return busy(button.closest('form'), () => setControl(character, button.dataset.clear, { target: '', goal: 0 }));
  busy(button.closest('li'), async () => {
    await api(`/characters/${character.id}/controls/${encodeURIComponent(button.dataset.forget)}`, 'DELETE', {});
    toast(`${character.name}: ${labelOf(character, button.dataset.forget)} zapomenuto.`); await load();
  });
});
$('automation').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target, character = characterOf(form);
  if (form.matches('[data-command]')) {
    const input = form.querySelector('input');
    return busy(form, async () => {
      await api(`/characters/${character.id}/command`, 'POST', { command: input.value });
      toast(`${character.name}: příkaz ${input.value.trim()} předán CODE. Výsledek uvidíš v logu.`);
      drafts.delete(draftKey(character.id, '', 'command')); input.value = ''; await load();
    });
  }
  const control = controlOf(character, form.dataset.control);
  if (!control) return;
  const field = name => form.querySelector(`[data-field="${name}"]`)?.value ?? '';
  let value = field('value');
  if (control.type === 'target') value = { target: field('target').trim(), goal: Math.max(0, Math.floor(Number(field('goal')) || 0)) };
  else if (control.type === 'number') {
    value = Number(value);
    if (!Number.isFinite(value) || field('value') === '') return toast('Zadej číslo.', true);
  }
  busy(form, () => setControl(character, control.key, value));
});
$('automation-reload').addEventListener('click', () => busy($('automation-reload').parentElement, load));

on('dashboard', offline => { if (offline) return; if (!data) load(); else render(); });
on('states', render);
on('reset', () => { data = null; $('automation').innerHTML = ''; });
setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
await boot();
