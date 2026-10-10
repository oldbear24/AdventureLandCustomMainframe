// CODE editor page: local drafts and scripts linked to the game's CODE slots.
import { $, api, app, boot, escape, isRunning, number, on, refresh, shortSlot, toast } from './core.js';

let selectedScript = '', dirty = false, selectedRemoteVersion = null, selectedRemoteSlot = null;
const usersOf = scriptId => app.dashboard.characters.filter(c => c.scriptId === scriptId);
const editorPanel = () => document.querySelector('.editor-panel');

function renderScriptList() {
  const { scripts } = app.dashboard;
  const html = scripts.length ? scripts.map(script => {
    const users = usersOf(script.id).map(c => c.name + (isRunning(c.id) ? ' (běží)' : ''));
    return `<button class="script-item" role="listitem" data-script-id="${script.id}" aria-current="${script.id === selectedScript}"><strong>${escape(script.name)}</strong><span class="tag ${script.remoteSlot ? 'slot' : 'draft'}" title="${escape(script.remoteSlot || '')}">${script.remoteSlot ? `SLOT ${escape(shortSlot(script.remoteSlot))} · v${escape(script.remoteVersion ?? '?')}` : 'NÁVRH'}</span><small>${users.length ? `Používá: ${escape(users.join(', '))}` : 'Nepoužívá žádná postava'}</small></button>`;
  }).join('') : '<p class="muted">Zatím žádné skripty. Načti herní slot níže.</p>';
  if ($('script-list').dataset.html !== html) { $('script-list').innerHTML = html; $('script-list').dataset.html = html; }
}
function updateEditingHeader() {
  const script = app.dashboard?.scripts.find(s => s.id === selectedScript);
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
  editorPanel().classList.toggle('is-dirty', dirty);
  $('nav-dirty').hidden = !dirty;
  const runningUsers = script ? usersOf(script.id).filter(c => isRunning(c.id)).length : 0;
  $('save-script').textContent = script?.remoteSlot ? `Uložit do herního slotu ${script.remoteSlot}${runningUsers ? ` a aktualizovat ${runningUsers} ${runningUsers === 1 ? 'postavu' : 'postavy'}` : ''}` : 'Uložit návrh';
  const source = $('script-source').value;
  $('source-stats').textContent = `${source.split('\n').length} řádků · ${number(source.length)} znaků`;
  $('import-target').textContent = script ? `Načtení nahradí obsah skriptu „${script.name}“ obsahem vybraného slotu.` : 'Načtení vytvoří nový propojený skript.';
}
// The open script is part of the address, so a reload or a link from a character card opens it.
function rememberScript() {
  const url = new URL(location.href);
  if (selectedScript) url.searchParams.set('script', selectedScript); else url.searchParams.delete('script');
  history.replaceState(null, '', url);
}
function newScript() {
  selectedScript = ''; selectedRemoteVersion = selectedRemoteSlot = null; $('script-name').value = ''; $('script-source').value = '// Adventure Land CODE\n// Vlož vlastní skript a přiřaď ho postavě.\n'; $('delete-script').hidden = true; dirty = false; $('editor-note').textContent = 'Místní návrh. Pro běh ho propoj s herním slotem.';
  rememberScript();
  if (app.dashboard) { renderScriptList(); updateEditingHeader(); }
}
function setEditor(script) {
  selectedScript = script.id; selectedRemoteVersion = script.remoteVersion || null; selectedRemoteSlot = script.remoteSlot || null;
  $('script-name').value = script.name; $('script-source').value = script.source;
  $('delete-script').hidden = false; dirty = false;
  $('delete-script').textContent = selectedRemoteSlot ? 'Odpojit slot z panelu' : 'Smazat návrh';
  $('editor-note').textContent = selectedRemoteSlot ? 'Uložení zapíše herní slot a aktualizuje postavy, které ho spouští.' : 'Místní návrh. Pro běh ho propoj s herním slotem.';
  rememberScript();
  if (app.dashboard) { renderScriptList(); updateEditingHeader(); }
}
async function selectScript(id) {
  if (dirty && !confirm('V editoru máš neuložené změny. Zahodit je?')) return false;
  if (!id) { newScript(); return true; }
  editorPanel().inert = true;
  try { setEditor(await api(`/scripts/${id}`)); return true; }
  catch (error) { toast(error.message, true); return false; }
  finally { editorPanel().inert = false; }
}

let opened = false;
on('dashboard', offline => {
  if (offline) return;
  $('load-code-slots').disabled = !app.dashboard.gameApi?.configured;
  renderScriptList(); updateEditingHeader();
  if (!opened) {
    opened = true;
    const requested = new URLSearchParams(location.search).get('script');
    if (requested && app.dashboard.scripts.some(s => s.id === requested)) selectScript(requested); else newScript();
  }
});
on('reset', () => { $('script-source').value = ''; $('script-name').value = ''; selectedScript = ''; selectedRemoteVersion = selectedRemoteSlot = null; dirty = false; opened = false; });

$('load-code-slots').addEventListener('click', async () => {
  $('load-code-slots').disabled = true;
  try {
    const { slots } = await api('/code-slots');
    $('code-slot-picker').innerHTML = slots.map(slot => `<option value="${escape(slot.slot)}">${escape(slot.slot)} · ${escape(slot.name)}</option>`).join('');
    if (selectedRemoteSlot && slots.some(slot => slot.slot === selectedRemoteSlot)) $('code-slot-picker').value = selectedRemoteSlot;
    $('import-code-slot').disabled = slots.length === 0;
    if (!slots.length) toast('Ve hře nejdřív ulož CODE do slotu.', true);
  } catch (error) { toast(error.message, true); }
  finally { $('load-code-slots').disabled = !app.dashboard.gameApi?.configured; }
});
$('import-code-slot').addEventListener('click', async () => {
  const slot = $('code-slot-picker').value;
  if (!slot) return;
  if ((dirty || (selectedScript && !selectedRemoteSlot && $('script-source').value)) && !confirm('Načíst obsah herního slotu místo obsahu v editoru?')) return;
  $('import-code-slot').disabled = true; editorPanel().inert = true;
  try {
    const script = await api(`/code-slots/${encodeURIComponent(slot)}/import`, 'POST', { scriptId: selectedScript || null });
    await refresh(); setEditor(script); toast('Herní slot propojen.');
  } catch (error) { toast(error.message, true); }
  finally { $('import-code-slot').disabled = false; editorPanel().inert = false; }
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
  $('save-script').disabled = true; editorPanel().inert = true;
  try {
    const script = await api(`/scripts${selectedScript ? `/${selectedScript}` : ''}`, selectedScript ? 'PUT' : 'POST', { name: $('script-name').value, source: $('script-source').value, ...(selectedScript ? { expectedVersion: selectedRemoteVersion } : {}) });
    await refresh(); setEditor(script);
    $('editor-note').textContent = script.remoteSlot ? `Uloženo do herního slotu ${script.remoteSlot}. Běh postav se synchronizuje.` : 'Uloženo jako návrh. Pro běh načti společný herní slot.';
    toast(script.remoteSlot ? 'Herní slot uložen. Běh postav se synchronizuje.' : 'Návrh uložen.');
  } catch (error) { toast(error.message, true); }
  finally { $('save-script').disabled = false; editorPanel().inert = false; }
});
$('delete-script').addEventListener('click', async () => {
  if (!selectedScript || !confirm(selectedRemoteSlot ? 'Odpojit tento slot z panelu? Herní CODE zůstane uložený.' : 'Smazat tento návrh?')) return;
  try { await api(`/scripts/${selectedScript}`, 'DELETE', {}); await refresh(); newScript(); } catch (error) { toast(error.message, true); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

await boot();
