import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { rootCertificates, checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { configFromEnv } from './config.js';

export async function checkHealth(config) {
  const options = { hostname: '127.0.0.1', port: config.port, path: '/healthz', timeout: 4000 };
  if (config.tls.enabled) {
    const cert = await readFile(config.tls.certFile, 'utf8');
    const certificate = new X509Certificate(cert);
    const dns = /DNS:([^,]+)/.exec(certificate.subjectAltName || '')?.[1];
    const ip = /IP Address:([^,]+)/.exec(certificate.subjectAltName || '')?.[1];
    const commonName = /(?:^|\n)CN=([^\n]+)/.exec(certificate.subject)?.[1];
    const hostname = (config.publicOrigin ? new URL(config.publicOrigin).hostname : (dns || ip || commonName || 'localhost').replace(/^\*\./, 'health.')).replace(/^\[|\]$/g, '');
    options.ca = [...rootCertificates, cert];
    if (!isIP(hostname)) options.servername = hostname;
    // Verify the configured name with Node's TLS verifier, retaining CA validation.
    options.checkServerIdentity = (_hostname, peer) => checkServerIdentity(hostname, peer);
  }
  return new Promise((resolve, reject) => {
    const request = (config.tls.enabled ? https : http).get(options, response => {
      response.resume();
      response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('Healthcheck selhal.')));
    });
    request.on('timeout', () => request.destroy(new Error('Healthcheck timeout.')));
    request.on('error', reject);
  });
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/src/healthcheck.js')) {
  checkHealth(configFromEnv()).catch(() => { process.exitCode = 1; });
}
