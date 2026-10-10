import { GameAccount } from './game-account.js';
import { GAME_ORIGIN } from './runtime.js';
import path from 'node:path';
import { scriptSchema } from './store.js';

const failure = (status, message) => Object.assign(new Error(message), { status });
const SLOT = /^[a-zA-Z0-9_-]{1,64}$/;
function defaultSlotOf(character) {
  const slot = [character.assignment?.code_slot, character.character_id].find(value => typeof value === 'string' && SLOT.test(value));
  return slot || null;
}
// Last known realm: "EU IV" from a Mainframe assignment, or "SR_EUIV" from the account snapshot.
function realmOf(character) {
  const assigned = /^(EU|US|ASIA) ([a-zA-Z0-9_-]{1,24})$/.exec(character.assignment?.server || '');
  const snapshot = /^SR_(EU|US|ASIA)([a-zA-Z0-9_-]{1,24})$/.exec(character.profile?.server || '');
  const match = snapshot || assigned;
  return match ? { region: match[1], server: match[2] } : { region: null, server: null };
}
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
  async requestMethod(method, args, token = this.vault.config.authCookie) {
    if (!['mainframe_list_characters', 'list_codes', 'get_code', 'save_code'].includes(method)) throw failure(400, 'Nepovolená API metoda.');
    if (!token) throw failure(409, 'Nejdřív připoj API token v dialogu Herní účet.');
    let response, result;
    try {
      response = await this.request(`${GAME_ORIGIN}/mcp_api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ ...args, token }),
      });
      result = await response.json();
    } catch { throw failure(502, 'API Adventure Land neodpovídá. Zkus načtení později.'); }
    if (response.status === 429 || result?.reason === 'rate_limited') throw failure(429, 'API omezuje počet požadavků. Zkus načtení později.');
    if (response.status === 401 || result?.reason === 'invalid_token') throw failure(401, 'API token není platný nebo byl odvolán.');
    if (result?.reason === 'not_found') throw failure(404, 'Herní CODE slot neexistuje.');
    if (!response.ok || !result?.success) throw failure(502, 'API Adventure Land odmítlo požadavek.');
    return result;
  }
  async call(token) {
    const result = await this.requestMethod('mainframe_list_characters', {}, token);
    if (!Array.isArray(result.characters)) throw failure(502, 'API nevrátilo platný seznam postav.');
    // Never proxy the full upstream profile, which can contain game authentication fields.
    return result.characters.filter(c => /^[a-zA-Z0-9_]{1,32}$/.test(c.character)).map(c => ({
      name: c.character, level: Number(c.level) || 0, class: typeof c.class === 'string' ? c.class : '',
      online: !!c.profile?.online, ...realmOf(c), codeSlot: defaultSlotOf(c),
    }));
  }
  // The game keeps one default CODE slot per character, named after its character id.
  defaultSlot(name) {
    return this.exclusive(async () => {
      const characters = await this.call(this.vault.config.authCookie);
      return characters.find(c => c.name.toLowerCase() === name.toLowerCase())?.codeSlot || null;
    });
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
  listCodes() {
    return this.exclusive(async () => {
      const result = await this.requestMethod('list_codes', {});
      if (!Array.isArray(result.codes)) throw failure(502, 'API nevrátilo seznam CODE slotů.');
      return result.codes.filter(code => /^[a-zA-Z0-9_-]{1,64}$/.test(code.slot)).map(code => ({ slot: String(code.slot), name: String(code.name || code.slot), version: String(code.version) }));
    });
  }
  async readCode(slot) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(slot)) throw failure(400, 'Neplatný CODE slot.');
    const result = await this.requestMethod('get_code', { slot });
    const code = result.code;
    if (!code || String(code.slot) !== slot || !['string', 'number'].includes(typeof code.version)) throw failure(502, 'API nevrátilo platný CODE slot.');
    const parsed = scriptSchema.safeParse({ name: code.name, source: code.code });
    if (!parsed.success) throw failure(502, 'Herní slot obsahuje neplatný nebo příliš dlouhý JavaScript.');
    return { ...parsed.data, remoteSlot: slot, remoteVersion: String(code.version) };
  }
  getCode(slot) { return this.exclusive(() => this.readCode(slot)); }
  saveCode(slot, input, expectedVersion) {
    return this.exclusive(async () => {
      const current = await this.readCode(slot);
      if (current.remoteVersion !== expectedVersion) throw failure(409, 'Herní CODE se mezitím změnil. Načti slot znovu a sluč svoje změny.');
      await this.requestMethod('save_code', { slot, name: input.name, code: input.source });
      const saved = await this.readCode(slot);
      if (saved.source !== input.source || saved.name !== input.name) throw failure(409, 'Slot se změnil během ukládání. Načti ho znovu a zkontroluj obsah.');
      return saved;
    });
  }
  disconnect() { return this.exclusive(async () => { await this.vault.save({ cookie: '' }); return this.status(); }); }
}
