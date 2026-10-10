import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { ensureSelfSignedCertificate } from './certificate.js';

const RELOAD_INTERVAL = 12 * 60 * 60 * 1000;

export async function loadTlsMaterial(config, log = console.log) {
  if (config.tls.selfSigned) {
    const { cert, key, generated, fingerprint } = await ensureSelfSignedCertificate(config.tls);
    if (generated) log(`Vygenerován self-signed TLS certifikát ${config.tls.certFile} pro ${config.tls.hostnames.join(', ')} (SHA-256 ${fingerprint}).`);
    return { cert, key };
  }
  try { const [cert, key] = await Promise.all([readFile(config.tls.certFile), readFile(config.tls.keyFile)]); return { cert, key, passphrase: config.tls.passphrase || undefined }; }
  catch { throw new Error('Nelze načíst TLS certifikát nebo privátní klíč. Zkontroluj cesty a oprávnění.'); }
}

// HTTPS only; the certificate is re-read periodically so renewals apply without a restart.
export async function createWebServer(config, app) {
  let material = await loadTlsMaterial(config), server;
  try { server = https.createServer({ ...material, minVersion: 'TLSv1.2' }, app); }
  catch { throw new Error('Neplatný TLS certifikát, klíč nebo heslo klíče. HTTPS nebylo spuštěno.'); }
  const reload = setInterval(async () => {
    try {
      const next = await loadTlsMaterial(config);
      if (next.cert.equals(material.cert) && next.key.equals(material.key)) return;
      server.setSecureContext({ ...next, minVersion: 'TLSv1.2' }); material = next;
      console.log('TLS certifikát byl znovu načten.');
    } catch (error) { console.error(`Obnovení TLS certifikátu selhalo: ${error.message}`); }
  }, RELOAD_INTERVAL); reload.unref();
  server.on('close', () => clearInterval(reload));
  return server;
}
