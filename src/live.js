import { WebSocketServer } from 'ws';

const FLUSH_INTERVAL = 200;
const PING_INTERVAL = 30_000;

// Pushes character state changes to logged-in panels over a WebSocket at /api/live.
export function attachLive(server, app, runtime) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const pending = new Map();
  server.on('upgrade', (req, socket, head) => {
    // An exception in an upgrade listener would crash the process; refuse the request instead.
    try { upgrade(req, socket, head); } catch { socket.destroy(); }
  });
  const upgrade = (req, socket, head) => {
    socket.on('error', () => {});
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (new URL(req.url, 'https://localhost').pathname !== '/api/live') return reject('404 Not Found');
    // Browsers do not apply CORS to WebSockets, so the Origin and the session cookie are checked here.
    const expected = app.locals.publicOrigin || `https://${req.headers.host}`;
    if (req.headers.origin !== expected) return reject('403 Forbidden');
    const token = app.locals.sessionToken(req);
    if (!token) return reject('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, ws => {
      ws.token = token; ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('message', () => {});
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'snapshot', sessions: runtime.snapshot().map(({ id, state }) => ({ id, state })) }));
    });
  };
  // Coalesce frequent updates: each character sends at most one state per flush.
  const onState = (id, state) => { pending.set(id, state); };
  runtime.on('state', onState);
  const flush = setInterval(() => {
    if (!pending.size) return;
    const message = JSON.stringify({ type: 'states', states: [...pending].map(([id, state]) => ({ id, state })) });
    pending.clear();
    for (const ws of wss.clients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) ws.send(message);
  }, FLUSH_INTERVAL); flush.unref();
  // Drop dead connections and those whose panel session expired or logged out.
  const check = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive || !app.locals.sessionActive(ws.token)) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, PING_INTERVAL); check.unref();
  app.locals.closeLive = token => { for (const ws of wss.clients) if (ws.token === token) ws.close(4401, 'logout'); };
  let closed = false;
  const close = () => { if (closed) return; closed = true; clearInterval(flush); clearInterval(check); runtime.off('state', onState); for (const ws of wss.clients) ws.terminate(); wss.close(); };
  server.on('close', close);
  return { wss, close };
}
