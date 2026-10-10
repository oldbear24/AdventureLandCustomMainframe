// Logs page: game and CODE log entries, live over the WebSocket.
import { $, app, boot, escape, on } from './core.js';

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
let first = true;
on('dashboard', offline => {
  if (offline) return;
  renderFilter(); scheduleRender();
  if (first) { first = false; requestAnimationFrame(scrollLogsToBottom); }
});
on('logs', scheduleRender);
on('live', scheduleRender);
$('log-filter').addEventListener('change', () => {
  const url = new URL(location.href);
  if ($('log-filter').value === 'all') url.searchParams.delete('character'); else url.searchParams.set('character', $('log-filter').value);
  history.replaceState(null, '', url);
  renderLogs(); scrollLogsToBottom();
});
$('logs').addEventListener('scroll', () => { const element = $('logs'); $('logs-bottom').hidden = element.scrollHeight - element.scrollTop - element.clientHeight < 70; });
$('logs-bottom').addEventListener('click', scrollLogsToBottom);

await boot({ live: true, logs: true });
