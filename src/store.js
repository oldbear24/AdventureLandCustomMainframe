import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { z } from 'zod';

export const characterSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_]{1,32}$/),
  region: z.enum(['EU', 'US', 'ASIA']),
  server: z.string().regex(/^[a-zA-Z0-9_-]{1,24}$/),
  scriptId: z.string().uuid().nullable().default(null),
  autoStart: z.boolean().default(false),
}).strict();
export const scriptSchema = z.object({
  name: z.string().trim().min(1).max(80),
  source: z.string().max(512_000).refine(source => {
    try { new Script(source); return true; } catch { return false; }
  }, 'CODE obsahuje chybu syntaxe. Použij běžný JavaScript bez import/export.'),
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  characters: z.array(characterSchema.extend({ id: z.string().uuid() })),
  scripts: z.array(scriptSchema.extend({ id: z.string().uuid(), updatedAt: z.string() })),
});

export class Store {
  constructor(dir) { this.dir = dir; this.state = { version: 1, characters: [], scripts: [] }; this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try { this.state = stateSchema.parse(JSON.parse(await readFile(path.join(this.dir, 'state.json'), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  snapshot() { return structuredClone(this.state); }
  update(fn) {
    const operation = this.queue.then(async () => {
      const next = this.snapshot();
      const result = fn(next);
      stateSchema.parse(next);
      const temporary = path.join(this.dir, `state-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temporary, path.join(this.dir, 'state.json'));
      this.state = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
