import { configFromEnv } from './config.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createApp } from './app.js';

const config = configFromEnv();
const store = new Store(config.dataDir); await store.init();
const runtime = new Runtime(config, store);
const app = createApp(config, store, runtime);
const server = app.listen(config.port, config.host, () => console.log(`Adventure Land Mainframe: http://${config.host}:${config.port}`));
server.on('error', error => { console.error(error.message); process.exit(1); });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  const timeout = setTimeout(() => process.exit(1), 20_000); timeout.unref();
  app.locals.dispose();
  const closed = new Promise(resolve => server.close(resolve));
  await runtime.close(); await closed; clearTimeout(timeout);
}
process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
runtime.init().catch(error => runtime.log(null, 'error', error.message));
