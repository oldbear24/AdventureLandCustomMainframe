import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SystemMonitor, descendants, readCgroup, readProcesses } from '../src/system.js';

const stat = (pid, name, ppid, utime, stime, rssPages) => `${pid} (${name}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 100 1000 ${rssPages} 0`;
async function fakeSystem(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'al-system-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc'), cgroup = path.join(root, 'cgroup'), data = path.join(root, 'data');
  const write = async (pid, line) => { await mkdir(path.join(proc, String(pid)), { recursive: true }); await writeFile(path.join(proc, String(pid), 'stat'), line); };
  await write(1, stat(1, 'init', 0, 1, 1, 10));
  await write(10, stat(10, 'node', 1, 100, 50, 1000));
  await write(11, stat(11, 'chrome', 10, 200, 100, 2000));
  await write(12, stat(12, 'chrome (renderer)', 11, 300, 0, 3000));
  await write(13, stat(13, 'other', 1, 999, 999, 9999));
  await mkdir(path.join(proc, 'self'), { recursive: true });
  await mkdir(cgroup, { recursive: true }); await mkdir(data, { recursive: true });
  await writeFile(path.join(cgroup, 'memory.max'), '2147483648\n'); await writeFile(path.join(cgroup, 'memory.current'), '1073741824\n');
  await writeFile(path.join(cgroup, 'cpu.max'), '200000 100000\n'); await writeFile(path.join(cgroup, 'cpu.stat'), 'usage_usec 5000000\nuser_usec 1\n');
  await writeFile(path.join(data, 'state.json'), '{}'); await writeFile(path.join(data, 'history.json'), 'x'.repeat(100));
  return { proc, cgroup, data, write };
}

test('Chromium processes are the panel\'s descendants and the container limits come from cgroup', async t => {
  const f = await fakeSystem(t);
  const processes = await readProcesses(f.proc);
  assert.equal(processes.length, 5);
  assert.equal(processes.find(p => p.pid === 12).name, 'chrome (renderer)');
  assert.deepEqual(descendants(processes, 10).map(p => p.pid).sort(), [11, 12]);
  assert.equal(await readProcesses(path.join(f.proc, 'missing')), null);
  assert.deepEqual(await readCgroup(f.cgroup), { memoryLimit: 2147483648, memoryUsed: 1073741824, cpuLimit: 2, cpuUsageMicros: 5_000_000 });
  await writeFile(path.join(f.cgroup, 'memory.max'), 'max'); await writeFile(path.join(f.cgroup, 'cpu.max'), 'max 100000');
  const unlimited = await readCgroup(f.cgroup);
  assert.equal(unlimited.memoryLimit, null); assert.equal(unlimited.cpuLimit, null);
});

test('CPU shares are measured between samples and the report includes the data volume and characters', async t => {
  const f = await fakeSystem(t);
  let now = 1_000_000;
  const session = { id: 'id-1', status: 'running', startedAt: new Date(now).toISOString(), attempts: 0, character: { name: 'Runner' }, state: { ping: 42 },
    page: { context: () => ({ newCDPSession: async () => ({ send: async method => method === 'Performance.getMetrics' ? { metrics: [{ name: 'JSHeapUsedSize', value: 5e6 }, { name: 'JSHeapTotalSize', value: 8e6 }, { name: 'Nodes', value: 120 }] } : {}, detach: async () => {} }) }) } };
  const runtime = { sessions: new Map([['id-1', session], ['id-2', { id: 'id-2', status: 'reconnecting', attempts: 3, character: { name: 'Away' } }]]) };
  const monitor = new SystemMonitor({ dataDir: f.data }, runtime, { proc: f.proc, cgroup: f.cgroup, pid: 10, now: () => now });
  const first = await monitor.sample();
  assert.equal(first.cgroup.cpu, null); assert.equal(first.browser.processes, 2); assert.equal(first.browser.rss, 5000 * 4096);
  // 10 s later: chrome used 100 more ticks (1 s of CPU) and the container 4 s.
  now += 10_000;
  await f.write(12, stat(12, 'chrome (renderer)', 11, 400, 0, 3000));
  await writeFile(path.join(f.cgroup, 'cpu.stat'), 'usage_usec 9000000\n');
  const second = await monitor.sample();
  assert.equal(Math.round(second.browser.cpu), 10); assert.equal(Math.round(second.cgroup.cpu), 40);
  const report = await monitor.report();
  assert.equal(report.history.length, 2); assert.equal(report.history[1].cpu, second.cgroup.cpu); assert.equal(report.history[1].memory, 1073741824);
  assert.deepEqual(report.data, { bytes: 102, files: 2 });
  assert.ok(report.disk.total > 0); assert.equal(report.host.node, process.version);
  assert.deepEqual(report.characters.map(c => [c.name, c.status, c.ping, c.heapUsed, c.nodes, c.attempts]), [['Away', 'reconnecting', null, null, null, 3], ['Runner', 'running', 42, 5e6, 120, 0]]);
});
