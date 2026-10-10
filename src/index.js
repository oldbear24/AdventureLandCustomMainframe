import { configFromEnv } from './config.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { createApp } from './app.js';
import { createWebServer } from './server.js';
import { GameAccount } from './game-account.js';
import { GameApi } from './game-api.js';

const config = configFromEnv();
const store = new Store(config.dataDir); await store.init();
const gameApi = new GameApi(config); await gameApi.init();
const runtime = new Runtime(config, store, undefined, gameApi);
const account = new GameAccount(config, runtime); await account.init();
const app = createApp(config, store, runtime, account, gameApi);
const server = await createWebServer(config, app);
server.listen(config.port, config.host, () => console.log(`Adventure Land Mainframe: ${config.tls.enabled ? 'https' : 'http'}://${config.host}:${config.port}`));
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
