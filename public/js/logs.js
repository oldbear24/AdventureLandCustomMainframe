// Logs page: game and CODE log entries, live over the WebSocket, and the stored week of them page by page.
import { $, api, app, boot, escape, number, on, pageFromUrl, pageSize, pager, savePageInUrl, savePageSize } from './core.js';

// A character card links here with ?character=<id>; it preselects the filter once.
let requested = new URLSearchParams(location.search).get('character'), frame = 0;
function scrollLogsToBottom() { $('logs').scrollTop = $('logs').scrollHeight; $('logs-bottom').hidden = true; }
function renderFilter() {
  const filter = requested || $('log-filter').value || 'all';
  requested = null;
  const options = `<option value="all">Všechny postavy</option><option value="system">Systém</option>${app.dashboard.characters.map(c => `<option value="${c.id}">${escape(c.name)}</option>`).join('')}`;
  // Rebuild only on change, so an open dropdown is not closed by the 5 s refresh.
  if ($('log-filter').dataset.options !== options) { $('log-filter').innerHTML = options; $('log-filter').dataset.options = options; }
  $('log-filter').value = [...$('log-filter').options].some(o => o.value === filter) ? filter : 'all';
}
function renderLogs() {
  const filter = $('log-filter').value, element = $('logs'), { dashboard } = app;
  $('logs-mode').textContent = `Posledních 200 záznamů · ${app.liveConnected ? 'živě přes WebSocket' : 'obnova každých 5 sekund'}`;
  const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 70;
  const names = new Map(dashboard.characters.map(c => [c.id, c.name]));
  const logs = dashboard.logs.filter(l => filter === 'all' || (filter === 'system' ? !l.characterId : l.characterId === filter));
  element.innerHTML = logs.length ? logs.map(l => `<div class="log-line ${l.level === 'error' ? 'error' : ''}"><span class="log-time">${new Date(l.at).toLocaleTimeString('cs-CZ')}</span><span class="log-name">${escape(names.get(l.characterId) || 'SYSTEM')}</span><div class="log-message">${escape(l.message)}</div></div>`).join('') : '<span class="log-time">Zatím žádné logy. Spusť postavu a sleduj její běh.</span>';
  if (nearBottom) scrollLogsToBottom();
}
// At most one render per animation frame, however many log batches arrive.
function scheduleRender() {
  if (frame || !app.dashboard) return;
  frame = requestAnimationFrame(() => { frame = 0; renderLogs(); });
}
// History mode reads the stored logs from the server; filters and the page live in the address.
const params = new URLSearchParams(location.search);
let mode = params.get('mode') === 'history' ? 'history' : 'live', page = pageFromUrl(), size = pageSize('logs', 100), historyLoaded = false, historyRequest = 0;
$('log-search').value = params.get('q') || '';
$('log-errors').checked = params.get('errors') === '1';
$('log-until').value = /^\d{4}-\d{2}-\d{2}$/.test(params.get('until') || '') ? params.get('until') : '';
function saveHistoryFilters() {
  const url = new URL(location.href);
  const set = (key, value) => { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); };
  set('mode', mode === 'history' ? 'history' : ''); set('q', mode === 'history' ? $('log-search').value.trim() : '');
  set('errors', mode === 'history' && $('log-errors').checked ? '1' : ''); set('until', mode === 'history' ? $('log-until').value : '');
  history.replaceState(null, '', url);
  savePageInUrl(mode === 'history' ? page : 1);
}
function showMode() {
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  $('log-history').hidden = mode !== 'history';
  document.querySelector('.log-panel').hidden = mode === 'history';
  saveHistoryFilters();
  if (mode === 'history') loadHistory(); else requestAnimationFrame(scrollLogsToBottom);
}
async function loadHistory() {
  const filter = $('log-filter').value, until = $('log-until').value, request = ++historyRequest;
  const search = new URLSearchParams({ page: String(page), limit: String(size) });
  if (filter !== 'all') search.set('character', filter);
  if ($('log-errors').checked) search.set('errors', '1');
  if ($('log-search').value.trim()) search.set('q', $('log-search').value.trim());
  if (until) search.set('until', String(new Date(`${until}T23:59:59.999`).getTime()));
  try {
    const result = await api(`/logs?${search}`);
    if (request !== historyRequest) return;
    historyLoaded = true;
    if (result.page > result.pages && result.total) { page = result.pages; return loadHistory(); }
    const names = new Map(app.dashboard.characters.map(c => [c.id, c.name]));
    $('log-history-list').innerHTML = !result.available ? '<span class="log-time">Uložené logy nejsou na tomto serveru dostupné.</span>' : result.entries.length
      ? result.entries.map(l => `<div class="log-line ${l.level === 'error' ? 'error' : ''}"><span class="log-time" title="${escape(new Date(l.at).toLocaleString('cs-CZ'))}">${escape(new Date(l.at).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span><span class="log-name">${escape(l.characterId ? names.get(l.characterId) || '?' : 'SYSTEM')}</span><div class="log-message">${escape(l.message)}</div></div>`).join('')
      : '<span class="log-time">Žádný uložený log neodpovídá filtrům.</span>';
    pager($('log-pager'), { ...result, size }, (next, nextSize) => { page = next; size = nextSize; savePageSize('logs', size); saveHistoryFilters(); loadHistory().then(() => $('log-history').scrollIntoView({ block: 'start' })); });
    $('logs-count').textContent = `${number(result.total)} ${result.total === 1 ? 'uložený záznam' : result.total > 1 && result.total < 5 ? 'uložené záznamy' : 'uložených záznamů'}`;
  } catch (error) { if (request === historyRequest) $('log-history-list').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
}
let first = true;
on('dashboard', offline => {
  if (offline) return;
  renderFilter(); scheduleRender();
  if (first) { first = false; if (mode === 'history') showMode(); else requestAnimationFrame(scrollLogsToBottom); }
  // The newest page of stored logs follows new entries; older pages stay put while being read.
  else if (mode === 'history' && historyLoaded && page === 1 && !$('log-until').value) loadHistory();
});
on('logs', scheduleRender);
on('live', scheduleRender);
$('log-filter').addEventListener('change', () => {
  const url = new URL(location.href);
  if ($('log-filter').value === 'all') url.searchParams.delete('character'); else url.searchParams.set('character', $('log-filter').value);
  history.replaceState(null, '', url);
  renderLogs(); scrollLogsToBottom();
  if (mode === 'history') { page = 1; saveHistoryFilters(); loadHistory(); }
});
document.querySelector('.view-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-mode]'); if (!button || button.dataset.mode === mode) return;
  mode = button.dataset.mode; page = 1; showMode();
});
let searchTimer;
$('log-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page = 1; saveHistoryFilters(); loadHistory(); }, 300); });
for (const id of ['log-errors', 'log-until']) $(id).addEventListener('change', () => { page = 1; saveHistoryFilters(); loadHistory(); });
$('logs').addEventListener('scroll', () => { const element = $('logs'); $('logs-bottom').hidden = element.scrollHeight - element.scrollTop - element.clientHeight < 70; });
$('logs-bottom').addEventListener('click', scrollLogsToBottom);

await boot({ live: true, logs: true });
