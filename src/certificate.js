import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isIP, isIPv4 } from 'node:net';
import path from 'node:path';

const VALIDITY_DAYS = 365, RENEW_BEFORE_DAYS = 30, DAY = 24 * 60 * 60 * 1000;
const ECDSA_SHA256 = '1.2.840.10045.4.3.2';

// Minimal DER encoder, just enough for a self-signed X.509 v3 certificate.
const length = n => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = []; for (; n; n >>>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const seq = (...parts) => der(0x30, ...parts);
// DER integers are minimal: no redundant leading zero byte, and one added only to keep a set high bit positive.
const integer = bytes => {
  let start = 0; while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start++;
  const value = bytes.subarray(start);
  return der(0x02, value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
};
const oid = text => {
  const [first, second, ...rest] = text.split('.').map(Number), bytes = [first * 40 + second];
  for (let value of rest) { const encoded = [value & 0x7f]; while ((value >>>= 7)) encoded.unshift(0x80 | (value & 0x7f)); bytes.push(...encoded); }
  return der(0x06, Buffer.from(bytes));
};
const time = date => {
  const text = date.toISOString().replace(/[-:T]|\.\d+/g, '');
  return date.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(text.slice(2))) : der(0x18, Buffer.from(text));
};
const bitString = bytes => der(0x03, Buffer.from([0]), bytes);
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));

function ipBytes(ip) {
  if (isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  let text = ip.replace(/^\[|\]$/g, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) { const [a, b, c, d] = v4.split('.').map(Number); text = text.slice(0, -v4.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = text.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return Buffer.from(groups.flatMap(group => { const value = parseInt(group, 16); return [value >> 8, value & 0xff]; }));
}

export function createSelfSignedCertificate(hostnames, now = new Date()) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = randomBytes(16); serial[0] &= 0x7f;
  const name = seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from('Adventure Land Mainframe')))));
  const altNames = hostnames.map(host => isIP(host) ? der(0x87, ipBytes(host)) : der(0x82, Buffer.from(host, 'ascii')));
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))), integer(serial), seq(oid(ECDSA_SHA256)), name,
    seq(time(new Date(now.getTime() - 60 * 60 * 1000)), time(new Date(now.getTime() + VALIDITY_DAYS * DAY))), name, spki,
    der(0xa3, seq(
      extension('2.5.29.19', true, seq()),
      extension('2.5.29.15', true, der(0x03, Buffer.from([0x07, 0x80]))),
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      extension('2.5.29.17', false, seq(...altNames)),
      extension('2.5.29.14', false, der(0x04, createHash('sha1').update(spki).digest())),
    )),
  );
  const certificate = seq(tbs, seq(oid(ECDSA_SHA256)), bitString(sign('sha256', tbs, privateKey)));
  return {
    cert: Buffer.from(`-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`),
    key: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
}

function usable(cert, key, hostnames, now) {
  try {
    const certificate = new X509Certificate(cert);
    if (!certificate.checkPrivateKey(createPrivateKey(key))) return null;
    if (Date.parse(certificate.validTo) - now.getTime() < RENEW_BEFORE_DAYS * DAY) return null;
    const covered = hostnames.every(host => isIP(host) ? certificate.checkIP(host) : certificate.checkHost(host, { subject: 'never', wildcards: false }));
    return covered ? certificate : null;
  } catch { return null; }
}

async function writeAtomic(file, contents, mode) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, contents, { mode }); await rename(temporary, file);
}

// Reuses the stored certificate while it is valid for every hostname; otherwise generates a fresh one.
export async function ensureSelfSignedCertificate({ certFile, keyFile, hostnames }, now = new Date()) {
  const [cert, key] = await Promise.all([readFile(certFile), readFile(keyFile)]).catch(() => []);
  const existing = cert && key && usable(cert, key, hostnames, now);
  if (existing) return { cert, key, generated: false, fingerprint: existing.fingerprint256 };
  const created = createSelfSignedCertificate(hostnames, now);
  await mkdir(path.dirname(certFile), { recursive: true }); await mkdir(path.dirname(keyFile), { recursive: true });
  await writeAtomic(keyFile, created.key, 0o600); await writeAtomic(certFile, created.cert, 0o644);
  return { ...created, generated: true, fingerprint: new X509Certificate(created.cert).fingerprint256 };
}
