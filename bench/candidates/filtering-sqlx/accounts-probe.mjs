#!/usr/bin/env node
// node candidates/filtering-sqlx/accounts-probe.mjs [--accounts 100] [--scale 20k]
//
// Threads and memory with many accounts' pools open, for each database layer. Starts the
// candidate with BENCH_ACCOUNTS mirrors (copies of the harness's), reads the startup timings, then
// samples the server process's threads and RSS three times: idle after startup (one connection
// kept per account), after every account served 4 concurrent list requests (up to 4 connections
// each), and 30 s later. Run from bench/, holding the bench lock like ./load does.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as container from '../../harness/container.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name, def) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const accounts = Number(flag('accounts', 100));
const scale = flag('scale', '20k');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sample(name) {
  // The server is PID 1 in its container.
  const status = execFileSync('docker', ['exec', name, 'cat', '/proc/1/status'], { encoding: 'utf8' });
  const field = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(status)?.[1]);
  return { threads: field('Threads'), rss_mb: Math.round(field('VmRSS') / 102.4) / 10 };
}

const image = 'beghu-bench-filtering-sqlx';
container.build(join(root, 'candidates', 'filtering-sqlx'), image);
const out = { accounts, scale, started: new Date().toISOString(), runs: [] };
for (const db of ['rusqlite', 'sqlx']) {
  const workDir = join(root, 'results', `accounts-probe-tmp`);
  const box = await container.start({
    image,
    mirror: join(root, 'data', `mirror-${scale}.db`),
    workDir,
    limits: ['--cpus=4', '--memory=2g'],
    env: { BENCH_ACCOUNTS: accounts, BENCH_DB: db },
  });
  try {
    const startup = container.logs(box.name).split('\n').filter((l) => l.startsWith('sqlx'));
    const idle = sample(box.name);
    for (let a = 0; a < accounts; a++) {
      await Promise.all(
        ['bug', 'p1', 'ux', 'backend'].map((l) => fetch(`${box.url}/api/issues?label=${l}`, { headers: { 'x-account': String(a) } }).then((r) => r.arrayBuffer())),
      );
    }
    const touched = sample(box.name);
    await sleep(30_000);
    const later = sample(box.name);
    const run = { db, startup, idle, touched, after_30s: later };
    console.log(JSON.stringify(run));
    out.runs.push(run);
  } finally {
    container.stop(box.name);
    rmSync(workDir, { recursive: true, force: true });
  }
}
const dir = join(root, 'results', `${out.started.replace(/[:]/g, '').replace('T', '-').slice(0, 17)}-accounts-probe-${accounts}-${scale}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'probe.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`results: ${dir}/probe.json`);
