import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { GAME_ORIGIN } from './runtime.js';

function failure(status, message) { return Object.assign(new Error(message), { status }); }
export class GameAccount {
  constructor(config, runtime, request = fetch) {
    this.config = config; this.runtime = runtime; this.request = request;
    this.record = null; this.source = config.authCookie ? 'environment' : 'none';
    this.keyFile = path.join(config.dataDir, 'account.key');
    this.recordFile = path.join(config.dataDir, 'account.enc.json');
  }
  async init() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    let stored;
    try { stored = JSON.parse(await readFile(this.recordFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('Nelze načíst uloženou herní relaci.'); }
    try {
      const key = await readFile(this.keyFile);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      this.record = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'));
      if (typeof this.record.cookie !== 'string') throw new Error('Invalid session');
      this.config.authCookie = this.record.cookie;
      this.source = this.record.cookie ? 'saved' : 'none';
    } catch { throw new Error('Nelze dešifrovat herní relaci. Obnov account.key a account.enc.json ze stejné zálohy.'); }
  }
  status() {
    return { configured: !!this.config.authCookie, source: this.source, email: this.record?.email || null, signedInAt: this.record?.signedInAt || null };
  }
  async save(record) {
    let key;
    try { key = await readFile(this.keyFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      key = randomBytes(32);
      await writeFile(this.keyFile, key, { mode: 0o600, flag: 'wx' });
    }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()]);
    const temporary = path.join(this.config.dataDir, `account-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    await rename(temporary, this.recordFile);
    this.record = record; this.config.authCookie = record.cookie; this.source = record.cookie ? 'saved' : 'none';
  }
  login(email, password) {
    return this.runtime.exclusive(async () => {
      if (this.runtime.sessions.size) throw failure(409, 'Před změnou herního účtu zastav všechny postavy.');
      let response, data;
      try {
        response = await this.request(`${GAME_ORIGIN}/api/signup_or_login`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email, password, only_login: true }),
        });
        data = await response.json();
      } catch { throw failure(502, 'Adventure Land neodpovídá nebo přihlášení vypršelo. Zkus to později.'); }
      if (response.status === 429) throw failure(429, 'Adventure Land omezuje přihlašování. Zkus to později.');
      if (!response.ok || !data?.success || typeof data.user !== 'string' || typeof data.auth !== 'string' || !data.user || !data.auth) {
        throw failure(401, 'Přihlášení k Adventure Land selhalo. Zkontroluj e-mail a heslo. Pro Steam účet můžeš použít cookie.');
      }
      await this.save({ cookie: `${data.user}-${data.auth}`, email, signedInAt: new Date().toISOString() });
      this.runtime.log(null, 'info', 'Herní účet přihlášen.');
      return this.status();
    });
  }
  setCookie(cookie) {
    return this.runtime.exclusive(async () => {
      if (this.runtime.sessions.size) throw failure(409, 'Před změnou herního účtu zastav všechny postavy.');
      await this.save({ cookie, email: null, signedInAt: new Date().toISOString() });
      this.runtime.log(null, 'info', 'Herní cookie uložena. Přihlášení bude ověřeno při spuštění postavy.');
      return this.status();
    });
  }
  disconnect(store) {
    return this.runtime.exclusive(async () => {
      await store.update(state => { for (const character of state.characters) character.autoStart = false; });
      for (const id of [...this.runtime.sessions.keys()]) await this.runtime.stopInternal(id);
      await this.save({ cookie: '', email: null, signedInAt: null });
      this.runtime.log(null, 'info', 'Herní účet odpojen a automatický start postav vypnut.');
      return this.status();
    });
  }
}
