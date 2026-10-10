import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';

export async function createWebServer(config, app) {
  if (!config.tls.enabled) return http.createServer(app);
  let cert, key;
  try { [cert, key] = await Promise.all([readFile(config.tls.certFile), readFile(config.tls.keyFile)]); }
  catch { throw new Error('Nelze načíst TLS certifikát nebo privátní klíč. Zkontroluj cesty a oprávnění.'); }
  try { return https.createServer({ cert, key, passphrase: config.tls.passphrase || undefined, minVersion: 'TLSv1.2' }, app); }
  catch { throw new Error('Neplatný TLS certifikát, klíč nebo heslo klíče. HTTPS nebylo spuštěno.'); }
}
