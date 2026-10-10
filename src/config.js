import path from 'node:path';
import { isIP } from 'node:net';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

export function configFromEnv(env = process.env) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) {
    throw new Error('Nastav ADMIN_PASSWORD v .env (alespoň 16 znaků).');
  }
  const port = Number(env.PORT || 3000);
  const maxCharacters = Number(env.MAX_CHARACTERS || 4);
  const username = env.ADMIN_USERNAME || 'admin';
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(username)) throw new Error('Neplatný ADMIN_USERNAME.');
  if (!!env.TLS_CERT_FILE !== !!env.TLS_KEY_FILE) throw new Error('Vlastní certifikát vyžaduje TLS_CERT_FILE i TLS_KEY_FILE.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Neplatný PORT.');
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 4) throw new Error('MAX_CHARACTERS musí být 1–4.');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN musí být https:// origin bez cesty.');
    publicOrigin = url.origin;
  }
  const hostnames = (env.TLS_HOSTNAMES || '').split(',').map(name => name.trim().replace(/^\[|\]$/g, '').toLowerCase()).filter(Boolean);
  for (const name of hostnames) if (!isIP(name) && !HOSTNAME.test(name)) throw new Error(`Neplatný název v TLS_HOSTNAMES: ${name}`);
  if (publicOrigin) hostnames.unshift(new URL(publicOrigin).hostname.replace(/^\[|\]$/g, ''));
  const warnings = [];
  if (env.TLS_ENABLED === 'false') warnings.push('TLS_ENABLED=false se ignoruje: panel běží vždy jen přes HTTPS.');
  if (env.COOKIE_SECURE === 'false') warnings.push('COOKIE_SECURE=false se ignoruje: session cookie je vždy Secure.');
  const dataDir = path.resolve(env.DATA_DIR || './data'), selfSigned = !env.TLS_CERT_FILE;
  return {
    host: env.HOST || '127.0.0.1', port, maxCharacters,
    username, password: env.ADMIN_PASSWORD, authCookie: env.AL_AUTH_COOKIE || '',
    cookieName: env.AL_COOKIE_NAME || 'auth', dataDir, publicOrigin, warnings,
    tls: {
      selfSigned, hostnames: [...new Set([...hostnames, 'localhost', '127.0.0.1', '::1'])],
      certFile: selfSigned ? path.join(dataDir, 'tls', 'cert.pem') : path.resolve(env.TLS_CERT_FILE),
      keyFile: selfSigned ? path.join(dataDir, 'tls', 'key.pem') : path.resolve(env.TLS_KEY_FILE),
      passphrase: env.TLS_KEY_PASSPHRASE || '',
    },
  };
}
