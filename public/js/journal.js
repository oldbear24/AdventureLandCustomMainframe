// Journal page: the persistent timeline of starts, disconnects, deaths, level-ups, CODE changes and server events.
import { $, api, app, boot, escape, on } from './core.js';

const TYPES = {
  start: ['▶', 'Start', ''], connected: ['●', 'Připojeno', 'good'], disconnected: ['⚠', 'Výpadek', 'bad'], stop: ['■', 'Stop', ''],
  death: ['☠', 'Smrt', 'bad'], level: ['▲', 'Level', 'good'], code: ['⌘', 'CODE', ''], code_error: ['⌘', 'Chyba CODE', 'bad'],
  alert: ['!', 'Upozornění', 'warn'], move: ['⇄', 'Přesun', ''], event: ['✦', 'Server', 'info'],
};
const params = new URLSearchParams(location.search);
let selected = new Set((params.get('type') || '').split(',').filter(t => Object.hasOwn(TYPES, t)));
let character = params.get('character') || '', entries = [], more = false, loading = false, available = true;

function saveFilters() {
  const url = new URL(location.href);
  if (selected.size) url.searchParams.set('type', [...selected].join(',')); else url.searchParams.delete('type');
  if (character) url.searchParams.set('character', character); else url.searchParams.delete('character');
  history.replaceState(null, '', url);
}
const query = extra => {
  const search = new URLSearchParams({ limit: '100', ...extra });
  if (selected.size) search.set('types', [...selected].join(','));
  if (character) search.set('character', character);
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
  $('journal-count').textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'záznam' : entries.length < 5 ? 'záznamy' : 'záznamů'}${more ? ' · starší se načtou tlačítkem' : ''}` : '';
  $('journal-more').hidden = !more;
}
async function load() {
  loading = true;
  try { const result = await api(query()); entries = result.entries; more = result.more; available = result.available; render(); }
  catch (error) { $('journal-list').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; }
}
// New entries are polled with every dashboard refresh and put on top.
async function poll() {
  if (loading || !entries.length) return load();
  try {
    const result = await api(query({ after: String(entries[0].id) }));
    if (result.entries.length) { entries = result.entries.concat(entries); render(); }
  } catch { /* The next refresh tries again. */ }
}
let opened = false;
on('dashboard', offline => { if (offline) return; if (!opened) { opened = true; renderTypes(); load(); } else poll(); });
on('reset', () => { opened = false; entries = []; });
$('journal-types').addEventListener('click', event => {
  const button = event.target.closest('[data-type]'); if (!button) return;
  const type = button.dataset.type;
  if (!type) selected.clear(); else if (selected.has(type)) selected.delete(type); else selected.add(type);
  saveFilters(); renderTypes(); load();
});
$('journal-character').addEventListener('change', () => { character = $('journal-character').value; saveFilters(); load(); });
$('journal-more').addEventListener('click', async () => {
  $('journal-more').disabled = true;
  try { const result = await api(query({ before: String(entries.at(-1).id) })); entries = entries.concat(result.entries); more = result.more; render(); }
  catch (error) { $('journal-count').textContent = error.message; }
  finally { $('journal-more').disabled = false; }
});

await boot();
