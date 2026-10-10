// Events page: bosses and server events reported by the game server to running characters, and which of them notify.
import { $, api, boot, duration, escape, mapList, number, on, percentage, toast } from './core.js';

let data = null, offset = 0, loading = false, mapTitles = new Map();
mapList().then(list => { mapTitles = new Map(list.map(m => [m.name, m.title])); if (data) render(); }, () => {});
const mapTitle = name => mapTitles.get(name) || name;
// Sets innerHTML only when it changed, so a refresh does not close an open checkbox focus or flicker.
function setHtml(element, html) { if (element.dataset.html !== html) { element.innerHTML = html; element.dataset.html = html; } }
const countdown = at => `<b data-until="${at}">${escape(remaining(at))}</b>`;
function remaining(at) {
  const ms = at - (Date.now() + offset);
  return ms > 0 ? duration(ms) : 'teď';
}
// The game client names most events itself; the rest are named from the public game data.
const titleOf = event => event.title !== event.key ? event.title : data.catalog.find(e => e.key === event.key)?.title || event.key;
function eventTile(event) {
  let badge, body = '';
  if (event.kind === 'boss' && event.live !== false) {
    badge = '<span class="badge running">ŽIVĚ</span>';
    if (event.maxHp) body += `<div><div class="meter-label"><span>HP</span><span>${number(event.hp)} / ${number(event.maxHp)} · ${percentage(event.hp, event.maxHp).toFixed(1)} %</span></div><div class="meter boss"><i style="--fill:${percentage(event.hp, event.maxHp)}%"></i></div></div>`;
    if (event.map) body += `<p class="event-line">◈ <a href="/map?map=${encodeURIComponent(event.map)}">${escape(mapTitle(event.map))}</a>${event.x !== null ? ` <small>${number(event.x)}, ${number(event.y)}</small>` : ''}</p>`;
    body += `<p class="event-line">${event.target ? `⚔ Cíl: <strong>${escape(event.target)}</strong>` : '<span class="muted">Zatím na nikoho neútočí.</span>'}</p>`;
  } else if (event.kind === 'boss') {
    badge = '<span class="badge">ČEKÁ</span>';
    body += event.spawn ? `<p class="event-line">Objeví se za ${countdown(event.spawn)}</p><p class="fine">${escape(new Date(event.spawn - offset).toLocaleString('cs-CZ'))}</p>` : '<p class="event-line muted">Čas objevení není známý.</p>';
  } else if (event.kind === 'event') {
    badge = '<span class="badge running">PROBÍHÁ</span>';
    if (event.end) body += `<p class="event-line">Končí za ${countdown(event.end)}</p>`;
    if (event.map) body += `<p class="event-line">◈ <a href="/map?map=${encodeURIComponent(event.map)}">${escape(mapTitle(event.map))}</a></p>`;
  } else {
    badge = '<span class="badge starting">SEZÓNNÍ</span>';
    body += event.end ? `<p class="event-line">Končí za ${countdown(event.end)}</p>` : '<p class="event-line muted">Sezónní událost je aktivní.</p>';
  }
  return `<article class="event-tile ${event.live !== false && event.kind !== 'seasonal' ? 'is-live' : ''}" data-event="${escape(event.key)}"><div class="card-head"><div><h3>${escape(titleOf(event))}</h3><small><code>${escape(event.key)}</code></small></div>${badge}</div>${body}</article>`;
}
function scheduleText(schedule) {
  if (!schedule || (!schedule.dailies.length && !schedule.nightlies.length)) return '';
  const hours = list => list.map(h => `${String(h).padStart(2, '0')}:00`).join(', ');
  return `<p class="fine">Rozvrh serveru (serverový čas${schedule.timeOffset ? `, UTC${schedule.timeOffset > 0 ? '+' : ''}${schedule.timeOffset}` : ''}): ${schedule.dailies.length ? `denní události ${hours(schedule.dailies)}` : ''}${schedule.dailies.length && schedule.nightlies.length ? ' · ' : ''}${schedule.nightlies.length ? `noční ${hours(schedule.nightlies)}` : ''}${schedule.night ? ' · teď je noc' : ''}</p>`;
}
function render() {
  const realms = data.realms;
  setHtml($('realms'), realms.length ? realms.map(realm => {
    const live = realm.events.filter(e => e.live !== false && e.kind !== 'seasonal').length;
    return `<section class="surface realm" data-realm="${escape(realm.realm)}"><div class="section-head"><div><h2>${escape(realm.realm)}</h2><p>Čteno přes ${escape(realm.via)} · ${escape(new Date(realm.observedAt - offset).toLocaleTimeString('cs-CZ'))}${live ? ` · <strong class="live-count">${live} aktivní</strong>` : ''}</p></div></div>${scheduleText(realm.schedule)}${realm.events.length ? `<div class="event-grid">${realm.events.map(eventTile).join('')}</div>` : '<p class="muted">Server teď nehlásí žádného bosse ani událost.</p>'}</section>`;
  }).join('') : '<div class="empty"><h2>Žádná postava neběží.</h2><p>Spusť postavu na stránce Postavy; bossy a události jejího serveru se objeví tady.</p></div>');
  const channels = [data.notifications.discord && 'Discord', data.notifications.telegram && 'Telegram'].filter(Boolean);
  $('event-notify-status').textContent = channels.length ? `Začátek vybraných bossů a událostí se pošle na ${channels.join(' a ')}.` : 'Webhook pro Discord ani Telegram není nastaven; výběr se uloží a začne platit po jeho nastavení v .env.';
  const selected = new Set(data.notifyEvents);
  setHtml($('event-catalog'), data.catalog.length ? data.catalog.map(e => `<label class="check event-option"><input type="checkbox" data-notify-event="${escape(e.key)}" ${selected.has(e.key) ? 'checked' : ''}>${escape(e.title)} <small>${e.kind === 'boss' ? 'boss' : 'událost'}</small></label>`).join('') : '<p class="fine">Seznam událostí se načte z herních dat.</p>');
}
async function load() {
  if (loading) return; loading = true;
  try { data = await api('/server-events'); offset = data.now - Date.now(); render(); }
  catch (error) { if (!data) $('realms').innerHTML = `<p class="error">${escape(error.message)}</p>`; }
  finally { loading = false; }
}
on('dashboard', offline => { if (!offline) load(); });
on('reset', () => { data = null; $('realms').innerHTML = ''; delete $('realms').dataset.html; });
// Countdowns tick every second between the 5 s refreshes.
setInterval(() => { for (const element of document.querySelectorAll('[data-until]')) element.textContent = remaining(Number(element.dataset.until)); }, 1000);
$('event-catalog').addEventListener('change', async event => {
  const input = event.target.closest('[data-notify-event]'); if (!input) return;
  const keys = [...document.querySelectorAll('[data-notify-event]:checked')].map(i => i.dataset.notifyEvent);
  for (const box of document.querySelectorAll('[data-notify-event]')) box.disabled = true;
  try { const result = await api('/settings/notify-events', 'PUT', { keys }); data.notifyEvents = result.notifyEvents; toast('Upozornění na události uložena.'); }
  catch (error) { input.checked = !input.checked; toast(error.message, true); }
  finally { for (const box of document.querySelectorAll('[data-notify-event]')) box.disabled = false; }
});

await boot();
