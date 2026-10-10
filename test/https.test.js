import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import https from 'node:https';
import { configFromEnv } from '../src/config.js';
import { createWebServer } from '../src/server.js';
import { checkHealth } from '../src/healthcheck.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';

const base = { ADMIN_USERNAME: 'operator', ADMIN_PASSWORD: 'https-test-password-long-enough' };
test('TLS config requires a cert/key pair, HTTPS origin and secure session cookies', () => {
  assert.throws(() => configFromEnv({ ...base, TLS_ENABLED: 'true' }), /TLS_CERT_FILE/);
  assert.throws(() => configFromEnv({ ...base, TLS_ENABLED: 'maybe' }), /TLS_ENABLED/);
  assert.throws(() => configFromEnv({ ...base, TLS_ENABLED: 'true', TLS_CERT_FILE: 'cert.pem', TLS_KEY_FILE: 'key.pem', PUBLIC_ORIGIN: 'http://example.com' }), /https/);
  const configuration = configFromEnv({ ...base, TLS_CERT_FILE: 'cert.pem', TLS_KEY_FILE: 'key.pem', COOKIE_SECURE: 'false' });
  assert.equal(configuration.tls.enabled, true); assert.equal(configuration.cookieSecure, true);
});
test('HTTPS serves the panel, accepts username/password, rejects the wrong user and verifies its certificate in healthcheck', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certFile = path.join(directory, 'cert.pem'), keyFile = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const config = configFromEnv({ ...base, DATA_DIR: directory, TLS_ENABLED: 'true', TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile, COOKIE_SECURE: 'false' });
  const store = new Store(directory); await store.init();
  const runtime = new Runtime(config, store), app = createApp(config, store, runtime);
  const server = await createWebServer(config, app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config.port = server.address().port;
  t.after(async () => { app.locals.dispose(); await runtime.close(); await new Promise(resolve => server.close(resolve)); });
  const ca = await readFile(certFile);
  const origin = `https://127.0.0.1:${config.port}`;
  async function request(endpoint, body, cookie = '') {
    return new Promise((resolve, reject) => {
      const encoded = body === undefined ? null : JSON.stringify(body);
      const req = https.request(`${origin}${endpoint}`, { ca, method: encoded ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }); req.on('error', reject); req.end(encoded);
    });
  }
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/api/login', { username: 'wrong', password: base.ADMIN_PASSWORD })).status, 401);
  const login = await request('/api/login', { username: base.ADMIN_USERNAME, password: base.ADMIN_PASSWORD });
  assert.equal(login.status, 200); assert.match(login.headers['set-cookie'][0], /Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('/api/dashboard', undefined, cookie)).status, 200);
  await checkHealth(config);
  await assert.rejects(checkHealth({ ...config, publicOrigin: 'https://wrong-host.example' }), /Hostname|IP|altnames|cert/i);
  assert.equal((await request('/api/logout', {}, cookie)).status, 200);
  assert.equal((await request('/api/dashboard', undefined, cookie)).status, 401);
  await assert.rejects(createWebServer({ ...config, tls: { ...config.tls, keyFile: certFile } }, app), /Neplatný TLS/);
  await assert.rejects(createWebServer({ ...config, tls: { ...config.tls, certFile: path.join(directory, 'missing.pem') } }, app), /Nelze načíst TLS/);
  const encryptedKey = path.join(directory, 'encrypted-key.pem');
  execFileSync('openssl', ['pkey', '-in', keyFile, '-aes-256-cbc', '-passout', 'pass:fixture-passphrase', '-out', encryptedKey], { stdio: 'ignore' });
  await createWebServer({ ...config, tls: { ...config.tls, keyFile: encryptedKey, passphrase: 'fixture-passphrase' } }, app);
  await assert.rejects(createWebServer({ ...config, tls: { ...config.tls, keyFile: encryptedKey, passphrase: 'wrong' } }, app), /Neplatný TLS/);
});
