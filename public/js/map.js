// Live map page, drawn on a canvas.
// The static layer (floor, walls, zones, doors, NPCs) is rendered into an offscreen canvas larger than the view
// and reused while the camera moves within it; characters and nearby entities are drawn over it each frame and
// glide between live updates.
// Nothing is drawn while nothing changes, and the DOM around the map is only touched when its text changes.
import { $, api, app, boot, characterName, classColors, ensureOwned, escape, mapList, number, on, runningSessions } from './core.js';

const params = new URLSearchParams(location.search);
const view = { name: params.get('map') || '', follow: params.get('follow') || '', list: null, listError: '', cache: new Map(), loading: new Set(), current: '' };
const camera = { x: 0, y: 0, scale: 1 };
const canvas = $('map-canvas'), frame = $('map-frame'), ctx = canvas.getContext('2d');
const layer = document.createElement('canvas'), layerCtx = layer.getContext('2d');
let width = 0, height = 0, dpr = 1, drawRequest = 0;
// What the last sync put on the map, and the clickable or hoverable spots of the last frame in screen pixels.
let scene = { own: [], nearby: [], saved: [] }, hits = [], doorHits = [];
const FONT = 'Inter, "Segoe UI", Arial, sans-serif';
const COLORS = { background: '#070b0a', floor: '#0e1714', wall: '#5c7a66', text: '#c9d8cf', zoneFill: '#f6a29712', zoneLine: '#f6a29755', zoneText: '#e8a99f', door: '#8fc3f5', doorFill: '#8fc3f533', npc: '#ead390', npcText: '#e9dcae', monster: '#f06b5b', targeting: '#ff3d2e', player: '#8fc3f5', saved: '#9cb1a5', debuff: '#ff5a47', buff: '#bcf878', danger: '#f6a297' };
const mapTitle = name => view.list?.find(m => m.name === name)?.title || name;

function currentMapName() {
  const followed = runningSessions().find(s => s.id === view.follow);
  if (followed) return followed.state.map;
  return view.name || runningSessions()[0]?.state.map || app.owned.find(c => c.map)?.map || 'main';
}
function remember() {
  const url = new URL(location.href);
  for (const [key, value] of [['map', view.follow ? '' : view.name], ['follow', view.follow]]) if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  history.replaceState(null, '', url);
}
async function fetchMap(name) {
  if (view.cache.has(name) || view.loading.has(name)) return;
  view.loading.add(name);
  try { view.cache.set(name, prepare(await api(`/maps/${encodeURIComponent(name)}`))); }
  catch (error) { view.cache.set(name, { error: error.message }); }
  finally { view.loading.delete(name); sync(); }
}
// Walls become one Path2D, built once per map.
function prepare(map) {
  const walls = new Path2D();
  for (const [x, y1, y2] of map.xLines) { walls.moveTo(x, y1); walls.lineTo(x, y2); }
  for (const [y, x1, x2] of map.yLines) { walls.moveTo(x1, y); walls.lineTo(x2, y); }
  const zones = map.monsters.map(zone => {
    const [x1, y1, x2, y2] = zone.box;
    return { label: `${zone.name}${zone.count ? ` ×${zone.count}` : ''}`, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  });
  return { ...map, walls, zones };
}

// Camera: world point at the canvas centre and pixels per world unit.
const limits = () => { const size = Math.max(width, height) || 1; return [size / 20_000, size / 120]; };
const clampScale = scale => { const [min, max] = limits(); return Math.min(max, Math.max(min, scale)); };
function fit(map) {
  const { minX, maxX, minY, maxY } = map.bounds, pad = 40;
  camera.x = (minX + maxX) / 2; camera.y = (minY + maxY) / 2;
  camera.scale = clampScale(Math.min(width / (maxX - minX + pad * 2), height / (maxY - minY + pad * 2)) || 1);
}
// Following starts from a close view.
function focus() { const size = Math.max(width, height); if (size / camera.scale > 1000) camera.scale = clampScale(size / 1000); }
function zoom(factor, screenX = width / 2, screenY = height / 2) {
  const scale = clampScale(camera.scale / factor);
  // The point under the cursor stays put; a followed character stays centred.
  if (!view.follow) {
    const worldX = camera.x + (screenX - width / 2) / camera.scale, worldY = camera.y + (screenY - height / 2) / camera.scale;
    camera.x = worldX - (screenX - width / 2) / scale; camera.y = worldY - (screenY - height / 2) / scale;
  }
  camera.scale = scale; requestDraw();
}

// Markers glide from their drawn position to each new reported one.
const GLIDE = 230, JUMP = 400;
const markers = new Map();
let markerSerial = 0;
function track(key, x, y, now) {
  const marker = markers.get(key);
  if (!marker) { markers.set(key, { x, y, fromX: x, fromY: y, toX: x, toY: y, start: 0, seen: now }); return key; }
  if (marker.toX !== x || marker.toY !== y) {
    const jump = Math.hypot(x - marker.x, y - marker.y) > JUMP;
    Object.assign(marker, { fromX: jump ? x : marker.x, fromY: jump ? y : marker.y, toX: x, toY: y, start: now });
  }
  marker.seen = now; return key;
}
// Nearby entities carry no id: each is matched to the closest marker of the same kind and name.
function trackNearby(entities, now) {
  const free = new Map();
  for (const [key, marker] of markers) if (key.startsWith('e:') && marker.seen !== now) {
    const group = key.slice(0, key.lastIndexOf(':'));
    free.set(group, [...(free.get(group) || []), [key, marker]]);
  }
  return entities.map(entity => {
    const group = `e:${entity.kind}:${entity.name}`, candidates = free.get(group) || [];
    let best = -1, bestDistance = 150;
    candidates.forEach(([, marker], index) => { const d = Math.hypot(marker.toX - entity.x, marker.toY - entity.y); if (d < bestDistance) { best = index; bestDistance = d; } });
    const key = best >= 0 ? candidates.splice(best, 1)[0][0] : `${group}:${++markerSerial}`;
    return { ...entity, key: track(key, entity.x, entity.y, now) };
  });
}
function glide(now) {
  let moving = false;
  for (const marker of markers.values()) {
    const t = marker.start ? Math.min(1, Math.max(0, (now - marker.start) / GLIDE)) : 1;
    marker.x = marker.fromX + (marker.toX - marker.fromX) * t; marker.y = marker.fromY + (marker.toY - marker.fromY) * t;
    if (t < 1) moving = true;
  }
  return moving;
}

// Rebuilds the scene from the dashboard; runs on live updates, not per frame.
function sync() {
  if (!app.dashboard) return;
  const name = currentMapName();
  renderControls(name); setText($('map-name'), mapTitle(name));
  const map = view.cache.get(name);
  if (!map || map.error) {
    scene = { own: [], nearby: [], saved: [] }; markers.clear();
    setText($('map-status'), map?.error || view.listError || 'Načítám mapu…');
    if (!map) fetchMap(name);
    scheduleSide(); requestDraw(); return;
  }
  if (view.current !== name) { view.current = name; markers.clear(); fit(map); if (view.follow) focus(); }
  const now = performance.now(), running = runningSessions().filter(s => s.state.map === name);
  const ownNames = new Set(running.map(s => s.state.name));
  const seen = new Set();
  const nearby = trackNearby(running.flatMap(s => s.state.nearby || []).filter(entity => {
    const key = `${entity.kind}:${entity.name}:${entity.x}:${entity.y}`;
    if (seen.has(key) || ownNames.has(entity.name)) return false;
    seen.add(key); return true;
  }), now);
  const own = running.map(s => {
    const effects = s.state.conditions || [], debuffs = effects.filter(e => e.kind === 'debuff'), buffs = effects.filter(e => e.kind === 'buff');
    const target = s.state.target && nearby.find(e => e.kind === 'monster' && e.target);
    return { id: s.id, key: track(`o:${s.id}`, s.state.x, s.state.y, now), name: s.state.name, x: s.state.x, y: s.state.y, color: classColors[s.state.ctype] || '#bcf878', dead: !!s.state.rip, ring: debuffs.length ? 'debuff' : buffs.length ? 'buff' : '', target: target?.key || null, tip: [s.state.name, ...effects.map(e => `${e.kind === 'debuff' ? '▼' : e.kind === 'buff' ? '▲' : '•'} ${e.name}`)].join('\n') };
  });
  const saved = app.owned.filter(c => c.map === name && Number.isFinite(c.x) && !running.some(s => s.state.name?.toLowerCase() === c.name.toLowerCase())).map(c => ({ name: c.name, x: c.x, y: c.y }));
  for (const [key, marker] of markers) if (marker.seen !== now) markers.delete(key);
  scene = { own, nearby, saved };
  setText($('map-status'), running.length ? `${running.length} ${running.length === 1 ? 'postava' : 'postavy'} na této mapě · ${app.liveConnected ? 'živě přes WebSocket' : 'obnova každých 5 s (živé spojení se obnovuje)'}` : saved.length ? 'Na této mapě neběží žádná postava; zobrazeny jsou uložené pozice.' : 'Na této mapě teď nikdo není.');
  scheduleSide(); requestDraw();
}

function requestDraw() { if (!drawRequest) drawRequest = requestAnimationFrame(draw); }
function label(context, text, x, y, color, { size = 11, bold = false, align = 'center' } = {}) {
  context.font = `${bold ? '700 ' : ''}${size}px ${FONT}`; context.textAlign = align;
  context.lineWidth = 3; context.lineJoin = 'round'; context.strokeStyle = COLORS.background; context.strokeText(text, x, y);
  context.fillStyle = color; context.fillText(text, x, y);
}
const visible = (x, y, margin = 60) => x > -margin && y > -margin && x < width + margin && y < height + margin;
// The layer reaches MARGIN pixels beyond each edge of the view, so panning and following a character only shift
// the finished bitmap; it is redrawn when the camera leaves that margin, zooms or the map changes.
const MARGIN = 200;
let layerAt = null;
function drawLayer(map) {
  const s = camera.scale, previous = layerAt;
  if (previous && previous.map === view.current && previous.scale === s && previous.width === width && previous.height === height && previous.dpr === dpr
    && Math.abs(camera.x - previous.x) * s <= MARGIN && Math.abs(camera.y - previous.y) * s <= MARGIN) return;
  layerAt = { map: view.current, x: camera.x, y: camera.y, scale: s, width, height, dpr }; doorHits = [];
  const c = layerCtx, w = width + MARGIN * 2, h = height + MARGIN * 2, ox = w / 2 - camera.x * s, oy = h / 2 - camera.y * s;
  const sx = x => ox + x * s, sy = y => oy + y * s, inside = (x, y, margin = 60) => x > -margin && y > -margin && x < w + margin && y < h + margin;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = COLORS.background; c.fillRect(0, 0, w, h);
  c.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  const { minX, maxX, minY, maxY } = map.bounds;
  c.fillStyle = COLORS.floor; c.fillRect(minX, minY, maxX - minX, maxY - minY);
  c.lineWidth = 1.5 / s; c.lineCap = 'square'; c.strokeStyle = COLORS.wall; c.setLineDash([]); c.stroke(map.walls);
  c.lineWidth = 1 / s; c.setLineDash([4 / s, 3 / s]); c.fillStyle = COLORS.zoneFill; c.strokeStyle = COLORS.zoneLine;
  for (const zone of map.zones) { c.fillRect(zone.x, zone.y, zone.w, zone.h); c.strokeRect(zone.x, zone.y, zone.w, zone.h); }
  c.setLineDash([]); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.textBaseline = 'alphabetic';
  for (const zone of map.zones) if (inside(sx(zone.x), sy(zone.y), 200)) label(c, zone.label, sx(zone.x) + 4, sy(zone.y) + 13, COLORS.zoneText, { align: 'left' });
  for (const door of map.doors) {
    const dw = Math.max(door.w * s, 12), dh = Math.max(door.h * s, 12), x = sx(door.x) - dw / 2, y = sy(door.y) - dh;
    if (!inside(x, y)) continue;
    c.fillStyle = COLORS.doorFill; c.fillRect(x, y, dw, dh); c.lineWidth = 1; c.strokeStyle = COLORS.door; c.strokeRect(x + 0.5, y + 0.5, dw - 1, dh - 1);
    label(c, `→ ${door.title}`, sx(door.x), sy(door.y) + 12, COLORS.door);
    doorHits.push({ type: 'door', to: door.to, x, y, w: dw, h: dh, tip: `Přejít na mapu ${door.title}` });
  }
  for (const npc of map.npcs) {
    const x = sx(npc.x), y = sy(npc.y);
    if (!inside(x, y)) continue;
    c.fillStyle = COLORS.npc; c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
    label(c, npc.name, x, y - 6, COLORS.npcText);
  }
}
function circle(x, y, r, fill, stroke, lineWidth = 1, dash = null) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.setLineDash(dash || []); ctx.lineWidth = lineWidth; ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]); }
}
function draw(now) {
  drawRequest = 0;
  if (!width || !height) return;
  const map = view.cache.get(view.current);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!map || map.error || view.current !== currentMapName()) { ctx.fillStyle = COLORS.background; ctx.fillRect(0, 0, width, height); hits = []; return; }
  const moving = glide(now);
  const followed = scene.own.find(o => o.id === view.follow);
  if (followed) { const marker = markers.get(followed.key); camera.x = marker.x; camera.y = marker.y; }
  drawLayer(map);
  // Where the layer's top-left corner lands on screen, rounded to whole device pixels to stay sharp.
  const shiftX = Math.round(((layerAt.x - camera.x) * camera.scale - MARGIN) * dpr) / dpr, shiftY = Math.round(((layerAt.y - camera.y) * camera.scale - MARGIN) * dpr) / dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(layer, shiftX * dpr, shiftY * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = camera.scale, ox = width / 2 - camera.x * s, oy = height / 2 - camera.y * s;
  const at = key => { const marker = markers.get(key); return [ox + marker.x * s, oy + marker.y * s]; };
  hits = doorHits.map(door => ({ ...door, x: door.x + shiftX, y: door.y + shiftY }));
  for (const entity of scene.nearby) {
    const [x, y] = at(entity.key);
    if (!visible(x, y)) continue;
    const monster = entity.kind === 'monster';
    circle(x, y, monster ? 3.5 : 4, monster ? (entity.target ? COLORS.targeting : COLORS.monster) : COLORS.player, entity.target && monster ? '#fff' : null);
    hits.push({ type: 'entity', x: x - 6, y: y - 6, w: 12, h: 12, tip: `${entity.name}${entity.target ? ' · útočí na postavu' : ''}` });
  }
  for (const c of scene.saved) {
    const x = ox + c.x * s, y = oy + c.y * s;
    if (!visible(x, y)) continue;
    circle(x, y, 6, null, COLORS.saved, 2, [3, 2]);
    label(ctx, `${c.name} (uloženo)`, x, y - 10, COLORS.saved);
    hits.push({ type: 'saved', x: x - 8, y: y - 8, w: 16, h: 16, tip: `${c.name} · poslední uložená pozice` });
  }
  for (const o of scene.own) {
    const [x, y] = at(o.key);
    if (o.target && markers.has(o.target)) {
      const [tx, ty] = at(o.target);
      ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff3d2e88'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.setLineDash([]);
    }
    // A coloured ring shows active effects: red for any debuff, green for buffs only.
    if (o.ring) circle(x, y, 12, null, o.ring === 'debuff' ? COLORS.debuff : COLORS.buff, 2.5, o.ring === 'debuff' ? [5, 3] : null);
    const isFollowed = o.id === view.follow;
    circle(x, y, 7, o.dead ? '#555' : o.color, o.dead ? COLORS.danger : isFollowed ? '#fff' : COLORS.background, isFollowed ? 3 : 2);
    label(ctx, `${o.name}${o.dead ? ' ✝' : ''}`, x, y - 12, o.color, { size: 12.5, bold: true });
    hits.push({ type: 'own', id: o.id, x: x - 10, y: y - 10, w: 20, h: 20, tip: o.tip });
  }
  // Read by the browser test to find markers and doors on the canvas.
  canvas.hits = hits; canvas.scene = scene;
  if (moving) requestDraw();
}
function resize() {
  const rect = frame.getBoundingClientRect();
  const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
  if (rect.width === width && rect.height === height && nextDpr === dpr) return;
  const first = !width;
  width = rect.width; height = rect.height; dpr = nextDpr;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  layer.width = Math.round((width + MARGIN * 2) * dpr); layer.height = Math.round((height + MARGIN * 2) * dpr);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`; layerAt = null;
  const map = view.cache.get(view.current);
  if (first && map && !map.error) { fit(map); if (view.follow) focus(); }
  requestDraw();
}
new ResizeObserver(resize).observe(frame);

// Text and lists around the map; each element is written only when its content changed.
function setText(element, text) { if (element.textContent !== text) element.textContent = text; }
function setHtml(element, html) { if (element.dataset.html !== html) { element.innerHTML = html; element.dataset.html = html; } }
function renderControls(name) {
  const running = runningSessions();
  const known = new Set([name, ...running.map(s => s.state.map), ...app.owned.map(c => c.map).filter(Boolean)]);
  const list = view.list || [...known].map(m => ({ name: m, title: m }));
  const picker = $('map-picker'), follow = $('map-follow');
  setHtml(picker, list.map(m => `<option value="${escape(m.name)}">${escape(m.title)}${known.has(m.name) && m.name !== name ? ' ●' : ''}</option>`).join(''));
  if (picker.value !== name) picker.value = name;
  if (view.follow && !running.some(s => s.id === view.follow)) { view.follow = ''; remember(); }
  setHtml(follow, `<option value="">Volný pohled</option>${running.map(s => `<option value="${s.id}">Sledovat ${escape(characterName(s.id))}</option>`).join('')}`);
  if (follow.value !== view.follow) follow.value = view.follow;
}
// The side lists change with every position update; they are refreshed at most twice a second.
let sideTimer = null, sideAt = -Infinity;
function scheduleSide() {
  if (sideTimer) return;
  sideTimer = setTimeout(() => { sideTimer = null; sideAt = performance.now(); renderSide(); }, Math.max(0, 500 - (performance.now() - sideAt)));
}
function renderSide() {
  if (!app.dashboard) return;
  const running = runningSessions(), name = currentMapName();
  const rows = running.map(s => `<button class="map-character ${s.id === view.follow ? 'active' : ''}" data-follow="${s.id}"><i style="background:${classColors[s.state.ctype] || '#bcf878'}"></i><span><strong>${escape(s.state.name)}</strong><small>${escape(mapTitle(s.state.map))} · ${number(s.state.x)}, ${number(s.state.y)}${s.state.target ? ` · cíl ${escape(s.state.target)}` : ''}</small>${(s.state.conditions || []).filter(e => e.kind !== 'neutral').length ? `<small class="map-effects">${s.state.conditions.filter(e => e.kind !== 'neutral').map(e => `<b class="${e.kind}">${escape(e.name)}</b>`).join(' ')}</small>` : ''}</span><em>živě</em></button>`);
  const runningNames = new Set(running.map(s => s.state.name?.toLowerCase()));
  for (const c of app.owned.filter(c => c.map && !runningNames.has(c.name.toLowerCase()))) {
    rows.push(`<button class="map-character saved" data-map="${escape(c.map)}"><i></i><span><strong>${escape(c.name)}</strong><small>${escape(mapTitle(c.map))} · ${number(c.x)}, ${number(c.y)}${c.online ? ' · online jinde' : ''}</small></span><em>uloženo</em></button>`);
  }
  setHtml($('map-characters'), rows.length ? rows.join('') : `<p class="fine">Žádná postava neběží.${app.dashboard.gameApi?.configured ? '' : ' S API tokenem uvidíš i uložené pozice ostatních postav účtu.'}</p>`);
  const followed = running.find(s => s.id === view.follow);
  if (!followed) setHtml($('map-nearby'), '<p class="fine">Vyber v poli Kamera postavu, kterou chceš sledovat.</p>');
  else {
    const counts = new Map();
    for (const e of followed.state.nearby || []) { const key = `${e.kind}:${e.name}`; counts.set(key, { ...e, count: (counts.get(key)?.count || 0) + 1, target: counts.get(key)?.target || e.target }); }
    setHtml($('map-nearby'), counts.size ? [...counts.values()].map(e => `<div class="nearby-row"><span class="nearby-kind ${e.kind}"></span><span>${escape(e.name)}</span><small>${e.target ? 'útočí na postavu · ' : ''}×${e.count}</small></div>`).join('') : '<p class="fine">V okolí nikdo není.</p>');
  }
  const map = view.cache.get(name);
  setHtml($('map-doors'), !map ? '<p class="fine">Načítám…</p>' : map.doors?.length ? [...new Map(map.doors.map(d => [d.to, d])).values()].map(d => `<button class="ghost small-button" data-door="${escape(d.to)}">→ ${escape(d.title)}</button>`).join('') : '<p class="fine">Žádné průchody.</p>');
}

function switchMap(name) { view.name = name; view.follow = ''; remember(); sync(); }
function followCharacter(id) {
  const session = runningSessions().find(s => s.id === id);
  view.follow = id; if (session) view.name = session.state.map;
  remember();
  if (view.current === currentMapName()) focus();
  sync(); renderSide();
}
function hitAt(x, y, types = null) {
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    if ((!types || types.includes(hit.type)) && x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) return hit;
  }
  return null;
}
const local = event => { const rect = canvas.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };
function showTip(hit, x, y) {
  const tip = $('map-tip');
  if (!hit) { tip.hidden = true; return; }
  setText(tip, hit.tip); tip.hidden = false;
  tip.style.left = `${Math.min(x + 14, width - tip.offsetWidth - 4)}px`; tip.style.top = `${Math.min(y + 14, height - tip.offsetHeight - 4)}px`;
}
let drag = null;
canvas.addEventListener('pointerdown', event => {
  drag = { x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', event => {
  const [x, y] = local(event);
  if (!drag) {
    const hit = hitAt(x, y);
    canvas.style.cursor = hit && (hit.type === 'door' || hit.type === 'own') ? 'pointer' : '';
    return showTip(hit, x, y);
  }
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) { drag.moved = true; showTip(null); canvas.classList.add('dragging'); }
  if (view.follow) { view.follow = ''; remember(); renderControls(currentMapName()); scheduleSide(); }
  camera.x = drag.cameraX - dx / camera.scale; camera.y = drag.cameraY - dy / camera.scale;
  requestDraw();
});
canvas.addEventListener('pointerup', event => {
  const current = drag; drag = null; canvas.classList.remove('dragging');
  if (!current || current.moved) return;
  const hit = hitAt(...local(event), ['door', 'own']);
  if (hit?.type === 'door') switchMap(hit.to); else if (hit?.type === 'own') followCharacter(hit.id);
});
canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('pointerleave', () => { if (!drag) showTip(null); });
canvas.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY > 0 ? 1.2 : 1 / 1.2, ...local(event)); }, { passive: false });
canvas.tabIndex = 0;
canvas.addEventListener('keydown', event => {
  const step = 80 / camera.scale, moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[event.key]) { event.preventDefault(); if (view.follow) { view.follow = ''; remember(); renderControls(currentMapName()); } camera.x += moves[event.key][0]; camera.y += moves[event.key][1]; requestDraw(); }
  else if (event.key === '+' || event.key === '=') zoom(1 / 1.4);
  else if (event.key === '-') zoom(1.4);
});
$('map-zoom-in').addEventListener('click', () => zoom(1 / 1.4));
$('map-zoom-out').addEventListener('click', () => zoom(1.4));
$('map-fit').addEventListener('click', () => { const map = view.cache.get(view.current); if (map?.bounds) { view.follow = ''; remember(); fit(map); sync(); } });
$('map-picker').addEventListener('change', () => switchMap($('map-picker').value));
$('map-follow').addEventListener('change', () => { if ($('map-follow').value) followCharacter($('map-follow').value); else { view.name = currentMapName(); view.follow = ''; remember(); sync(); } });
$('map-characters').addEventListener('click', event => {
  const row = event.target.closest('button'); if (!row) return;
  if (row.dataset.follow) followCharacter(row.dataset.follow); else if (row.dataset.map) switchMap(row.dataset.map);
});
$('map-doors').addEventListener('click', event => { const door = event.target.closest('[data-door]'); if (door) switchMap(door.dataset.door); });

let opened = false;
on('dashboard', offline => {
  if (offline) return;
  if (!opened) {
    opened = true;
    ensureOwned();
    mapList().then(list => { view.list = list; }, error => { view.listError = error.message; }).finally(sync);
  }
  sync();
});
on('states', sync);
on('owned', sync);
on('live', sync);
on('reset', () => { view.follow = ''; view.name = ''; opened = false; });

await boot({ live: true });
