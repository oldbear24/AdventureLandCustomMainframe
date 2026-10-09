import path from 'node:path';

export function configFromEnv(env = process.env) {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) {
    throw new Error('Nastav ADMIN_PASSWORD v .env (alespoň 16 znaků).');
  }
  const port = Number(env.PORT || 3000);
  const maxCharacters = Number(env.MAX_CHARACTERS || 4);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Neplatný PORT.');
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 4) throw new Error('MAX_CHARACTERS musí být 1–4.');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN musí být http(s) origin bez cesty.');
    publicOrigin = url.origin;
  }
  return {
    host: env.HOST || '127.0.0.1', port, maxCharacters,
    password: env.ADMIN_PASSWORD, authCookie: env.AL_AUTH_COOKIE || '',
    cookieName: env.AL_COOKIE_NAME || 'auth', dataDir: path.resolve(env.DATA_DIR || './data'),
    cookieSecure: env.COOKIE_SECURE === 'true', publicOrigin,
  };
}
