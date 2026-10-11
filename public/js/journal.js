// Journal page: the persistent timeline of starts, disconnects, deaths, level-ups, CODE changes and server events.
import { $, api, app, boot, escape, number, on, pageFromUrl, pageSize, pager, savePageInUrl, savePageSize } from './core.js';

const TYPES = {
  start: ['▶', 'Start', ''], connected: ['●', 'Připojeno', 'good'], disconnected: ['⚠', 'Výpadek', 'bad'], stop: ['■', 'Stop', ''],
  death: ['☠', 'Smrt', 'bad'], level: ['▲', 'Level', 'good'], code: ['⌘', 'CODE', ''], code_error: ['⌘', 'Chyba CODE', 'bad'],
  alert: ['!', 'Upozornění', 'warn'], move: ['⇄', 'Přesun', ''], event: ['✦', 'Server', 'info'],
};
const params = new URLSearchParams(location.search);
let selected = new Set((params.get('type') || '').split(',').filter(t => Object.hasOwn(TYPES, t)));
let character = params.get('character') || '', entries = [], loading = false, available = true;
// until jumps back in time: the list starts with the last entry of that day.
let until = /^\d{4}-\d{2}-\d{2}$/.test(params.get('until') || '') ? params.get('until') : '';
let page = pageFromUrl(), size = pageSize('journal', 100), result = { total: 0, page: 1, pages: 1 };
$('journal-until').value = until;
const untilTime = () => until ? new Date(`${until}T23:59:59.999`).getTime() : null;

function saveFilters() {
  const url = new URL(location.href);
  if (selected.size) url.searchParams.set('type', [...selected].join(',')); else url.searchParams.delete('type');
  if (character) url.searchParams.set('character', character); else url.searchParams.delete('character');
  if (until) url.searchParams.set('until', until); else url.searchParams.delete('until');
  history.replaceState(null, '', url);
}
const query = extra => {
  const search = new URLSearchParams({ limit: String(size), ...extra });
  if (selected.size) search.set('types', [...selected].join(','));
  if (character) search.set('character', character);
  if (until) search.set('until', String(untilTime()));
  return `/journal?${search}`;
};
function renderTypes() {
  $('journal-types').innerHTML = `<button class="ghost small-button" data-type="" aria-pressed="${!selected.size}">Vše</button>${Object.entries(TYPES).map(([type, [icon, label, tone]]) => `<button class="ghost small-button journal-type ${tone}" data-type="${type}" aria-pressed="${selected.has(type)}"><span aria-hidden="true">${icon}</span> ${label}</button>`).join('')}`;
}
function renderCharacters() {
  // Characters in the panel and any others named in the loaded entries (e.g. deleted ones).
  const names = new Map(app.dashboard.characters.map(c => [c.id, c.name]));
  for (const e of entries) if (e.characterId && e.name && !names.has(e.characterId)) names.set(e.characterId, e.name);
  if (character && !names.has(character)) names.set(character, '?');
  const html = `<option value="">Všechny</option>${[...names].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}`;
  if ($('journal-character').dataset.html !== html) { $('journal-character').innerHTML = html; $('journal-character').dataset.html = html; }
  $('journal-character').value = character;
}
const dayKey = at => new Date(at).toDateString();
function dayTitle(at) {
  const today = new Date(), day = new Date(at);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Dnes';
  if (day.toDateString() === yesterday.toDateString()) return 'Včera';
  return day.toLocaleDateString('cs-CZ', { weekday: 'long', day: 'numeric', month: 'long' });
}
function render() {
  renderCharacters();
  if (!available) { $('journal-list').innerHTML = '<p class="muted">Deník není na tomto serveru dostupný.</p>'; return; }
  if (!entries.length) { $('journal-list').innerHTML = `<div class="empty"><h2>Žádné záznamy.</h2><p>${selected.size || character ? 'Zkus jiný filtr.' : 'Záznamy přibudou, jakmile postavy poběží.'}</p></div>`; }
  else {
    let html = '', day = null;
    for (const e of entries) {
      if (dayKey(e.at) !== day) { if (day) html += '</ol>'; day = dayKey(e.at); html += `<h2 class="journal-day">${escape(dayTitle(e.at))}</h2><ol class="journal-entries">`; }
      const [icon, label, tone] = TYPES[e.type] || ['•', e.type, ''];
      const who = e.characterId ? `<a class="journal-who" href="/journal?character=${encodeURIComponent(e.characterId)}">${escape(e.name || '?')}</a>` : e.realm ? `<span class="journal-who">${escape(e.realm)}</span>` : '<span class="journal-who">Systém</span>';
      html += `<li class="journal-entry ${tone}" data-type="${e.type}"><time datetime="${new Date(e.at).toISOString()}">${escape(new Date(e.at).toLocaleTimeString('cs-CZ'))}</time><span class="journal-badge"><span aria-hidden="true">${icon}</span> ${escape(label)}</span>${who}<span class="journal-message">${escape(e.message)}</span></li>`;
    }
    $('journal-list').innerHTML = `${html}</ol>`;
  }
  const total = result.total;
  $('journal-count').textContent = total ? `${number(total)} ${total === 1 ? 'záznam' : total < 5 ? 'záznamy' : 'záznamů'}${until ? ` do ${new Date(untilTime()).toLocaleDateString('cs-CZ')}` : ''}` : '';
  pager($('journal-pager'), { page: result.page, pages: result.pages, total, size }, (next, nextSize) => {
    page = next; size = nextSize; savePageSize('journal', size); load().then(() => $('view-journal').scrollIntoView({ block: 'start' }));
  });
}
async function load() {
  loading = true;
  try {
    result = await api(query({ page: String(page) }));
    // A page past the end (fewer entries after a filter) shows the last one.
    if (result.page > result.pages) { page = result.pages; result = await api(query({ page: String(page) })); }
    entries = result.entries; available = result.available; page = result.page; savePageInUrl(page); render();
  }
  catch (error) { $('journal-list').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; }
}
// On the newest page, new entries are polled with every dashboard refresh and the page is reloaded with them.
async function poll() {
  if (loading) return;
  if (!entries.length) return load();
  if (page !== 1 || until) return;
  try {
    const fresh = await api(query({ after: String(entries[0].id), limit: '1' }));
    if (fresh.entries.length) await load();
  } catch { /* The next refresh tries again. */ }
}
let opened = false;
on('dashboard', offline => { if (offline) return; if (!opened) { opened = true; renderTypes(); load(); } else poll(); });
on('reset', () => { opened = false; entries = []; });
$('journal-types').addEventListener('click', event => {
  const button = event.target.closest('[data-type]'); if (!button) return;
  const type = button.dataset.type;
  if (!type) selected.clear(); else if (selected.has(type)) selected.delete(type); else selected.add(type);
  page = 1; saveFilters(); renderTypes(); load();
});
$('journal-character').addEventListener('change', () => { character = $('journal-character').value; page = 1; saveFilters(); load(); });
$('journal-until').addEventListener('change', () => { until = $('journal-until').value; page = 1; saveFilters(); load(); });
$('journal-newest').addEventListener('click', () => { until = ''; $('journal-until').value = ''; page = 1; saveFilters(); load(); });

await boot();
