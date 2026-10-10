import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const failure = (status, message) => Object.assign(new Error(message), { status });
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const base = { characterId: z.string().uuid(), to: z.string().regex(/^[a-zA-Z0-9_]{1,32}$/) };
export const transferSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('gold'), amount: positive }).strict(),
  z.object({ ...base, type: z.literal('item'), index: z.number().int().min(0).max(255), quantity: positive, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export function inventoryView(snapshot) {
  return { name: snapshot.name, gold: snapshot.gold, items: snapshot.items.map(item => ({
    index: item.index, name: item.name, level: item.level, quantity: item.quantity, locked: item.locked,
    fingerprint: createHash('sha256').update(item.serialized).digest('hex'),
  })) };
}
export class Transfers {
  constructor(runtime) { this.runtime = runtime; this.tickets = new Map(); }
  prune() {
    for (const [id, ticket] of this.tickets) if (ticket.retainUntil < Date.now()) this.tickets.delete(id);
  }
  prepare(input, owner) {
    input = transferSchema.parse(input);
    return this.runtime.exclusive(async () => {
      this.prune();
      if (this.tickets.size >= 500) throw failure(429, 'Příliš mnoho převodů. Zkus to později.');
      const snapshot = await this.runtime.inventory(input.characterId);
      if (snapshot.name.toLowerCase() === input.to.toLowerCase()) throw failure(400, 'Příjemce musí být jiná postava.');
      const command = { ...input };
      if (input.type === 'gold' && input.amount > snapshot.gold) throw failure(409, 'Postava nemá dost zlata.');
      if (input.type === 'item') {
        const item = snapshot.items.find(i => i.index === input.index);
        const view = inventoryView(snapshot).items.find(i => i.index === input.index);
        if (!item || view.fingerprint !== input.fingerprint) throw failure(409, 'Inventář se změnil. Načti ho znovu.');
        if (item.locked) throw failure(409, 'Zamčený nebo blokovaný předmět nelze poslat.');
        if (input.quantity > item.quantity) throw failure(409, 'Postava nemá požadovaný počet předmětů.');
        command.expectedItem = item.serialized; command.itemName = item.name; command.itemLevel = item.level;
      }
      const id = randomUUID(), expires = Date.now() + 60_000;
      this.tickets.set(id, { command, owner, page: this.runtime.sessions.get(input.characterId).page, expires, retainUntil: expires + 10 * 60_000, result: null });
      return { id, expires, from: snapshot.name, to: input.to, type: input.type, amount: input.amount, quantity: input.quantity, item: command.itemName, level: command.itemLevel };
    });
  }
  confirm(id, owner) {
    this.prune(); const ticket = this.tickets.get(id);
    if (!ticket || ticket.owner !== owner) throw failure(404, 'Potvrzení převodu neexistuje. Připrav nový převod.');
    // Store the promise before waiting: even concurrent retries execute only once.
    if (ticket.result) return ticket.result;
    ticket.result = this.runtime.exclusive(async () => {
      if (Date.now() > ticket.expires) throw failure(409, 'Potvrzení vypršelo. Připrav nový převod.');
      const session = this.runtime.sessions.get(ticket.command.characterId);
      if (!session || session.page !== ticket.page || session.status !== 'running') throw failure(409, 'Herní spojení se změnilo. Připrav nový převod.');
      const result = await this.runtime.sendTransfer(ticket.command);
      this.runtime.log(ticket.command.characterId, result.status === 'confirmed' ? 'info' : 'error', `Převod ${id}: ${result.status}, příjemce ${ticket.command.to}.`);
      return { id, ...result };
    });
    return ticket.result;
  }
}
