import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import https from 'node:https';
import { configFromEnv } from '../src/config.js';
import { createWebServer } from '../src/server.js';
import { createSelfSignedCertificate, ensureSelfSignedCertificate } from '../src/certificate.js';
import { checkHealth } from '../src/healthcheck.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';

const base = { ADMIN_USERNAME: 'operator', ADMIN_PASSWORD: 'https-test-password-long-enough' };
test('TLS config always uses HTTPS: generated certificate by default, own cert/key pair optionally', () => {
  assert.throws(() => configFromEnv({ ...base, TLS_CERT_FILE: 'cert.pem' }), /TLS_KEY_FILE/);
  assert.throws(() => configFromEnv({ ...base, PUBLIC_ORIGIN: 'http://example.com' }), /https/);
  assert.throws(() => configFromEnv({ ...base, TLS_HOSTNAMES: 'bad host' }), /TLS_HOSTNAMES/);
  const generated = configFromEnv({ ...base, DATA_DIR: 'data', PUBLIC_ORIGIN: 'https://AL.example.cz', TLS_HOSTNAMES: '192.168.1.5, nas.lan, [fd00::1]', TLS_ENABLED: 'false', COOKIE_SECURE: 'false' });
  assert.equal(generated.tls.selfSigned, true); assert.equal(generated.tls.certFile, path.resolve('data', 'tls', 'cert.pem'));
  assert.deepEqual(generated.tls.hostnames, ['al.example.cz', '192.168.1.5', 'nas.lan', 'fd00::1', 'localhost', '127.0.0.1', '::1']);
  assert.equal(generated.warnings.length, 2);
  const own = configFromEnv({ ...base, TLS_CERT_FILE: 'cert.pem', TLS_KEY_FILE: 'key.pem' });
  assert.equal(own.tls.selfSigned, false); assert.equal(own.tls.certFile, path.resolve('cert.pem'));
});
test('generated certificate is persisted, reused and regenerated when names change or it nears expiry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-cert-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = { certFile: path.join(directory, 'tls', 'cert.pem'), keyFile: path.join(directory, 'tls', 'key.pem'), hostnames: ['al.example.cz', 'localhost', '127.0.0.1', '::1'] };
  const first = await ensureSelfSignedCertificate(tls);
  assert.equal(first.generated, true);
  const certificate = new X509Certificate(first.cert);
  assert.equal(certificate.checkHost('al.example.cz'), 'al.example.cz'); assert.equal(certificate.checkIP('::1'), '::1');
  assert.equal(certificate.ca, false); assert.equal(certificate.verify(certificate.publicKey), true);
  if (process.platform !== 'win32') assert.equal((await stat(tls.keyFile)).mode & 0o777, 0o600);
  const again = await ensureSelfSignedCertificate(tls);
  assert.equal(again.generated, false); assert.equal(again.fingerprint, first.fingerprint);
  const renamed = await ensureSelfSignedCertificate({ ...tls, hostnames: [...tls.hostnames, 'nas.lan'] });
  assert.equal(renamed.generated, true); assert.notEqual(renamed.fingerprint, first.fingerprint);
  const later = await ensureSelfSignedCertificate({ ...tls, hostnames: [...tls.hostnames, 'nas.lan'] }, new Date(Date.now() + 340 * 24 * 60 * 60 * 1000));
  assert.equal(later.generated, true);
  await writeFile(tls.keyFile, createSelfSignedCertificate(['localhost']).key);
  assert.equal((await ensureSelfSignedCertificate(tls)).generated, true);
});
test('HTTPS with own certificate serves the panel, accepts username/password, rejects the wrong user and verifies its certificate in healthcheck', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'al-mainframe-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certFile = path.join(directory, 'cert.pem'), keyFile = path.join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const config = configFromEnv({ ...base, DATA_DIR: directory, TLS_CERT_FILE: certFile, TLS_KEY_FILE: keyFile });
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
