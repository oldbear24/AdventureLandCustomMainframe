import { GameAccount } from './game-account.js';
import { GAME_ORIGIN } from './runtime.js';
import path from 'node:path';

const failure = (status, message) => Object.assign(new Error(message), { status });
// Separate encrypted record and key; a game-login cookie and an API token are independent.
export class GameApi {
  constructor(config, request = fetch) {
    this.request = request;
    this.vault = new GameAccount({ ...config, authCookie: '' }, null);
    this.vault.keyFile = path.join(config.dataDir, 'api-token.key');
    this.vault.recordFile = path.join(config.dataDir, 'api-token.enc.json');
    this.queue = Promise.resolve();
  }
  init() { return this.vault.init(); }
  status() { return { configured: !!this.vault.config.authCookie }; }
  exclusive(fn) {
    const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result;
  }
  async call(token) {
    let response, result;
    try {
      response = await this.request(`${GAME_ORIGIN}/mcp_api/mainframe_list_characters`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ token }),
      });
      result = await response.json();
    } catch { throw failure(502, 'API Adventure Land neodpovídá. Zkus načtení později.'); }
    if (response.status === 429 || result?.reason === 'rate_limited') throw failure(429, 'API omezuje počet požadavků. Zkus načtení později.');
    if (response.status === 401 || result?.reason === 'invalid_token') throw failure(401, 'API token není platný nebo byl odvolán.');
    if (!response.ok || !result?.success || !Array.isArray(result.characters)) throw failure(502, 'API nevrátilo platný seznam postav.');
    // Never proxy the full upstream profile, which can contain game authentication fields.
    return result.characters.filter(c => /^[a-zA-Z0-9_]{1,32}$/.test(c.character)).map(c => ({
      name: c.character, level: Number(c.level) || 0, class: typeof c.class === 'string' ? c.class : '',
      online: !!c.profile?.online,
    }));
  }
  connect(token) {
    return this.exclusive(async () => {
      const characters = await this.call(token);
      await this.vault.save({ cookie: token });
      return { ...this.status(), characters };
    });
  }
  characters() {
    return this.exclusive(async () => {
      const token = this.vault.config.authCookie;
      if (!token) throw failure(409, 'Nejdřív připoj API token v dialogu Herní účet.');
      return { characters: await this.call(token) };
    });
  }
  disconnect() { return this.exclusive(async () => { await this.vault.save({ cookie: '' }); return this.status(); }); }
}
