// Server resources for the system page: CPU and memory of the panel, its Chromium processes and the container,
// the data volume, and per-character browser metrics. Linux /proc and cgroup files are read when present.
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SAMPLE_INTERVAL = 10_000;
export const HISTORY_LENGTH = 90;
// Linux reports process CPU time in clock ticks and memory in pages; both are 100 Hz and 4 KiB on common kernels.
const CLOCK_TICKS = 100, PAGE_SIZE = 4096;

const readText = file => readFile(file, 'utf8').then(text => text.trim(), () => null);
const toNumber = text => text !== null && /^\d+$/.test(text) ? Number(text) : null;

// pid, parent pid, CPU ticks and resident memory of every process, from /proc/<pid>/stat.
export async function readProcesses(proc = '/proc') {
  let entries;
  try { entries = await readdir(proc); } catch { return null; }
  const list = [];
  await Promise.all(entries.filter(name => /^\d+$/.test(name)).map(async pid => {
    const text = await readText(path.join(proc, pid, 'stat'));
    if (!text) return;
    // The command name is in parentheses and may contain spaces; fields after it are space separated.
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]), ticks = Number(fields[11]) + Number(fields[12]), rss = Number(fields[21]) * PAGE_SIZE;
    if ([ppid, ticks, rss].every(Number.isFinite)) list.push({ pid: Number(pid), ppid, ticks, rss, name: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')) });
  }));
  return list;
}
// Every descendant of root: the Chromium browser and its renderer, GPU and utility processes.
export function descendants(processes, root) {
  const children = new Map();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  const out = [], stack = [...(children.get(root) || [])];
  while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(children.get(p.pid) || [])); }
  return out;
}
// cgroup v2 (memory.max, cpu.max, cpu.stat) with a cgroup v1 fallback; null fields when not limited or unknown.
export async function readCgroup(root = '/sys/fs/cgroup') {
  const [max, current, cpuMax, cpuStat, v1Limit, v1Usage, v1Cpu] = await Promise.all([
    readText(path.join(root, 'memory.max')), readText(path.join(root, 'memory.current')), readText(path.join(root, 'cpu.max')), readText(path.join(root, 'cpu.stat')),
    readText(path.join(root, 'memory', 'memory.limit_in_bytes')), readText(path.join(root, 'memory', 'memory.usage_in_bytes')), readText(path.join(root, 'cpuacct', 'cpuacct.usage')),
  ]);
  const quota = /^(\d+) (\d+)$/.exec(cpuMax || '');
  const usage = /usage_usec (\d+)/.exec(cpuStat || '');
  let memoryLimit = toNumber(max) ?? toNumber(v1Limit);
  // cgroup v1 reports "no limit" as a huge number.
  if (memoryLimit !== null && memoryLimit >= 2 ** 60) memoryLimit = null;
  return {
    memoryLimit, memoryUsed: toNumber(current) ?? toNumber(v1Usage),
    cpuLimit: quota ? Number(quota[1]) / Number(quota[2]) : null,
    cpuUsageMicros: usage ? Number(usage[1]) : toNumber(v1Cpu) !== null ? toNumber(v1Cpu) / 1000 : null,
  };
}
async function directorySize(directory) {
  let total = 0, files = 0;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const info = await stat(path.join(directory, entry.name)).catch(() => null);
      if (info) { total += info.size; files++; }
    }
  } catch { return null; }
  return { bytes: total, files };
}

export class SystemMonitor {
  constructor(config, runtime, { proc = '/proc', cgroup = '/sys/fs/cgroup', pid = process.pid, now = Date.now } = {}) {
    this.config = config; this.runtime = runtime; this.proc = proc; this.cgroup = cgroup; this.pid = pid; this.now = now;
    this.previous = null; this.history = []; this.latest = null; this.timer = null;
  }
  start() {
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), SAMPLE_INTERVAL); this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  // CPU shares are measured between two samples, so the first sample has none yet.
  async sample() {
    const t = this.now(), processes = await readProcesses(this.proc), cgroup = await readCgroup(this.cgroup);
    const node = { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed, cpuMicros: process.cpuUsage().user + process.cpuUsage().system };
    const children = processes ? descendants(processes, this.pid) : null;
    const browser = children ? { processes: children.length, rss: children.reduce((sum, p) => sum + p.rss, 0), cpuMicros: children.reduce((sum, p) => sum + p.ticks, 0) * 1_000_000 / CLOCK_TICKS } : null;
    const previous = this.previous, elapsed = previous ? (t - previous.t) * 1000 : 0;
    const share = (now, before) => elapsed > 0 && now !== null && before !== null && now !== undefined && before !== undefined ? Math.max(0, (now - before) / elapsed * 100) : null;
    const snapshot = {
      t, node: { ...node, cpu: share(node.cpuMicros, previous?.node.cpuMicros) },
      browser: browser ? { ...browser, cpu: share(browser.cpuMicros, previous?.browser?.cpuMicros) } : null,
      cgroup: { ...cgroup, cpu: share(cgroup.cpuUsageMicros, previous?.cgroup.cpuUsageMicros) },
    };
    this.previous = snapshot; this.latest = snapshot;
    this.history.push({ t, cpu: snapshot.cgroup.cpu ?? ((snapshot.node.cpu ?? 0) + (snapshot.browser?.cpu ?? 0)), memory: snapshot.cgroup.memoryUsed ?? node.rss + (browser?.rss ?? 0) });
    if (this.history.length > HISTORY_LENGTH) this.history.shift();
    return snapshot;
  }
  // JS heap and DOM size of each running character's game page, from the Chrome DevTools protocol.
  async characters() {
    const out = [];
    for (const session of this.runtime.sessions.values()) {
      const row = { id: session.id, name: session.character?.name ?? '?', status: session.status, startedAt: session.startedAt, attempts: session.attempts || 0, ping: session.state?.ping ?? null, heapUsed: null, heapTotal: null, nodes: null };
      if (session.status === 'running' && session.page) {
        let client;
        try {
          client = await session.page.context().newCDPSession(session.page);
          await client.send('Performance.enable');
          const { metrics } = await Promise.race([client.send('Performance.getMetrics'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
          const metric = name => metrics.find(m => m.name === name)?.value ?? null;
          Object.assign(row, { heapUsed: metric('JSHeapUsedSize'), heapTotal: metric('JSHeapTotalSize'), nodes: metric('Nodes') });
        } catch { /* Metrics are optional; a busy or closing page simply has none. */ }
        finally { await client?.detach().catch(() => {}); }
      }
      out.push(row);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  async report() {
    const latest = this.latest || await this.sample();
    const disk = await statfs(this.config.dataDir).then(s => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }), () => null);
    return {
      now: this.now(), interval: SAMPLE_INTERVAL, latest, history: this.history,
      host: { platform: `${os.type()} ${os.release()}`, node: process.version, cpus: os.cpus().length, load: os.loadavg(), totalMemory: os.totalmem(), freeMemory: os.freemem(), uptime: Math.floor(os.uptime()) },
      process: { uptime: Math.floor(process.uptime()), pid: this.pid },
      disk, data: await directorySize(this.config.dataDir), characters: await this.characters(),
      storage: (() => { try { return this.runtime.history?.usage() ?? null; } catch { return null; } })(),
    };
  }
}
