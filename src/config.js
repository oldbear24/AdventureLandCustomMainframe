import path from 'node:path';

export function configFromEnv(env = process.env) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) {
    throw new Error('Nastav ADMIN_PASSWORD v .env (alespoň 16 znaků).');
  }
  const port = Number(env.PORT || 3000);
  const maxCharacters = Number(env.MAX_CHARACTERS || 4);
  const username = env.ADMIN_USERNAME || 'admin';
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(username)) throw new Error('Neplatný ADMIN_USERNAME.');
  for (const key of ['TLS_ENABLED', 'COOKIE_SECURE']) {
    if (env[key] && !['true', 'false'].includes(env[key])) throw new Error(`${key} musí být true nebo false.`);
  }
  const tlsEnabled = env.TLS_ENABLED === 'true' || (!env.TLS_ENABLED && !!(env.TLS_CERT_FILE && env.TLS_KEY_FILE));
  if (tlsEnabled && (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE)) throw new Error('HTTPS vyžaduje TLS_CERT_FILE a TLS_KEY_FILE.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Neplatný PORT.');
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 4) throw new Error('MAX_CHARACTERS musí být 1–4.');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN musí být http(s) origin bez cesty.');
    publicOrigin = url.origin;
  }
  if (tlsEnabled && publicOrigin && !publicOrigin.startsWith('https://')) throw new Error('Při zapnutém TLS musí PUBLIC_ORIGIN používat https://.');
  return {
    host: env.HOST || '127.0.0.1', port, maxCharacters,
    username, password: env.ADMIN_PASSWORD, authCookie: env.AL_AUTH_COOKIE || '',
    cookieName: env.AL_COOKIE_NAME || 'auth', dataDir: path.resolve(env.DATA_DIR || './data'),
    cookieSecure: tlsEnabled || publicOrigin.startsWith('https://') || env.COOKIE_SECURE === 'true', publicOrigin,
    tls: { enabled: tlsEnabled, certFile: env.TLS_CERT_FILE ? path.resolve(env.TLS_CERT_FILE) : '', keyFile: env.TLS_KEY_FILE ? path.resolve(env.TLS_KEY_FILE) : '', passphrase: env.TLS_KEY_PASSPHRASE || '' },
  };
}
