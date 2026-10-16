#!/usr/bin/env node
// ./bench/load <candidate>[:<variant>] [--scale 20k|50k|all] [--users 1,5,20] [--events 30]
//   [--accounts per-user|shared] [--conn pool|open] [--cpus 1] [--sqlite stock]
//
// Server cost of a few people using a candidate at once, over plain HTTP (no browser), for
// "Benchmark: client-side vs server-side filtering at 20k and 50k issues". A run starts the
// candidate on a fresh mirror copy, then runs three phases, sampling `docker stats` in each:
//
//   burst   every user cold-loads at the same moment, 5 times, 3 s apart
//   filter  every user runs the filter scenario's sequence (3 toggles 1 s apart, then "dark m"
//           typed 150 ms per key, then 3 more pages), 3 times; client variants send nothing here
//   live    every user holds /events open while one webhook a second arrives, and refetches
//           what the app would: its first page (server) or a delta since its cursor (client)
//
// `--client` (or a variant named client/worker) switches users to the client behaviour.
//
// beghu keeps one SQLite mirror per account, so by default every user is their own account
// (`--accounts per-user`: the candidate gets BENCH_ACCOUNTS=<users> and each user sends
// `x-account`); `--accounts shared` puts every user on one mirror. `--conn` is passed as
// BENCH_CONN (a pool per account, or a connection opened per request), `--cpus` sets the
// container's CPU limit. `--sqlite stock` builds the candidate with STOCK_SQLITE=1, for candidates
// that support it (filtering: rusqlite's default SQLite flags).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as container from './container.mjs';
import { dockerStats, summarize, round } from './metrics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, def) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : def);
const candidate = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);
if (!candidate) {
  console.error('usage: ./bench/load <candidate>[:<variant>] [--scale 20k|50k|all] [--users 1,5,20] [--events 30]');
  process.exit(2);
}
const [dir, variant] = candidate.split(':');
const client = argv.includes('--client') || variant === 'client' || variant === 'worker';
const scales = flag('scale', '20k') === 'all' ? ['20k', '50k'] : flag('scale', '20k').split(',');
const userCounts = flag('users', '1,5,20').split(',').map(Number);
const events = Number(flag('events', 30));
const accounts = flag('accounts', 'per-user');
const conn = flag('conn', 'pool');
const cpus = flag('cpus', '1');
const stock = flag('sqlite', '') === 'stock';

const LABELS = ['bug', 'enhancement', 'frontend', 'backend', 'ux', 'p2', 'performance', 'p1'];
const TEAM = ['ilze-k', 'martins-dev', 'anna-b', 'roberts', 'liga-p', 'edgars', 'zane-m'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function issuesUrl(base, view, offset = 0, limit = 100) {
  const p = new URLSearchParams({ state: view.state ?? 'open', offset: String(offset), limit: String(limit) });
  for (const l of view.labels ?? []) p.append('label', l);
  for (const a of view.assignees ?? []) p.append('assignee', a);
  if (view.q) p.set('q', view.q);
  return `${base}/api/issues?${p}`;
}

// A timed GET whose body is read in full (decompressed), like a browser would.
// A failed request is counted in `errors`, not timed.
const errors = [];
async function get(url, times, bytes, account = 0) {
  const t0 = performance.now();
  const r = await fetch(url, { headers: { 'x-account': String(account) } });
  const body = await r.arrayBuffer();
  if (!r.ok) {
    errors.push(`${r.status} ${url.replace(/^http:\/\/[^/]+/, '')}`);
    return body;
  }
  times.push(performance.now() - t0);
  if (bytes) bytes.push(Number(r.headers.get('content-length') ?? body.byteLength));
  return body;
}

async function phase(name, box, run) {
  const stats = dockerStats(box.name);
  await sleep(1500); // let docker stats take a first sample before the load starts
  const times = [];
  const failed = errors.length;
  const t0 = performance.now();
  await run(times);
  const wall = performance.now() - t0;
  await sleep(1500);
  const server = stats.stop();
  return { phase: name, requests: times.length, errors: errors.slice(failed), wall_ms: round(wall), latency_ms: summarize(times), server };
}

async function burst(box, users) {
  return phase('burst', box, async (times) => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(
        Array.from({ length: users }, async (_, u) => {
          const t0 = performance.now();
          await Promise.all([
            get(`${box.url}/api/facets`, [], null, u),
            get(client ? `${box.url}/api/snapshot?since=0` : issuesUrl(box.url, {}), [], null, u),
          ]);
          times.push(performance.now() - t0);
        }),
      );
      await sleep(3000);
    }
  });
}

async function filter(box, users) {
  return phase('filter', box, async (times) => {
    if (client) return; // filtering is local: nothing reaches the server
    await Promise.all(
      Array.from({ length: users }, async (_, u) => {
        await sleep(u * 137); // users don't click in lockstep
        for (let i = 0; i < 3; i++) {
          const label = LABELS[(u + i) % LABELS.length];
          const assignee = TEAM[(u + i) % TEAM.length];
          for (const view of [{ labels: [label] }, { labels: [label], assignees: [assignee] }, { state: 'closed', labels: [label], assignees: [assignee] }]) {
            await get(issuesUrl(box.url, view), times, null, u);
            await sleep(1000);
          }
          // Typing fires one request per key without waiting for the last, as the app does.
          const keys = [];
          for (let n = 1; n <= 'dark m'.length; n++) {
            keys.push(get(issuesUrl(box.url, { q: 'dark m'.slice(0, n) }), times, null, u));
            await sleep(150);
          }
          await Promise.all(keys);
          for (let p = 1; p <= 3; p++) {
            await get(issuesUrl(box.url, { q: 'dark m' }, p * 100, 100), times, null, u);
            await sleep(500);
          }
        }
      }),
    );
  });
}

// Holds /events open and calls `onEvent` for each message, until `signal` aborts.
async function listen(url, signal, onEvent) {
  const r = await fetch(`${url}/events`, { signal });
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (msg.split('\n').some((l) => l.startsWith('data:'))) onEvent();
      }
    }
  } catch {}
}

async function live(box, users, scale) {
  const feed = readFileSync(join(root, 'data', `webhooks-${scale}.jsonl`), 'utf8').trim().split('\n').slice(0, events).map((l) => JSON.parse(l));
  const bytes = [];
  const result = await phase('live', box, async (times) => {
    const abort = new AbortController();
    const inflight = [];
    // Each client user starts from the cursor a fresh snapshot would have.
    const seq0 = (await (await fetch(`${box.url}/api/snapshot?since=999999999`)).json()).seq;
    for (let u = 0; u < users; u++) {
      const view = { labels: [LABELS[u % LABELS.length]] };
      let seq = seq0;
      void listen(box.url, abort.signal, () => {
        if (client) {
          inflight.push(
            get(`${box.url}/api/snapshot?since=${seq}`, times, bytes, u).then((body) => {
              seq = Math.max(seq, JSON.parse(new TextDecoder().decode(body)).seq ?? seq);
            }),
          );
        } else inflight.push(get(issuesUrl(box.url, view), times, bytes, u));
      });
    }
    await sleep(500);
    for (const e of feed) {
      await fetch(`${box.url}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': e.event, 'x-github-delivery': crypto.randomUUID() },
        body: JSON.stringify(e.payload),
      });
      await sleep(1000);
    }
    await Promise.allSettled(inflight);
    abort.abort();
  });
  result.response_kb = summarize(bytes.map((b) => b / 1024));
  return result;
}

const results = { candidate, client, events, accounts, conn, cpus, sqlite: stock ? 'stock' : 'default', started: new Date().toISOString(), runs: [] };
const image = `beghu-bench-${dir}${stock ? '-stock' : ''}`;
console.log(`building ${image}... (${accounts} accounts, conn ${conn}, ${cpus} CPU${stock ? ', stock SQLite' : ''})`);
container.build(join(root, 'candidates', dir), image, stock ? { STOCK_SQLITE: 1 } : {});
const outDir = join(root, 'results', `${results.started.replace(/[:]/g, '').replace('T', '-').slice(0, 17)}-load-${candidate.replace(':', '-')}-${accounts}-${conn}-${cpus}cpu${stock ? '-stock' : ''}`);
mkdirSync(outDir, { recursive: true });

for (const scale of scales) {
  const mirror = join(root, 'data', `mirror-${scale}.db`);
  if (!existsSync(mirror)) throw new Error(`no ${mirror}; run ./bench/run once at this scale first`);
  for (const users of userCounts) {
    const workDir = join(outDir, 'tmp');
    const box = await container.start({
      image,
      mirror,
      workDir,
      limits: [`--cpus=${cpus}`, '--memory=512m'],
      env: { GITHUB_LATENCY_MS: 300, BENCH_ACCOUNTS: accounts === 'shared' ? 1 : users, BENCH_CONN: conn, ...(variant ? { BENCH_VARIANT: variant } : {}) },
    });
    try {
      const run = { scale, users, phases: [] };
      for (const p of [burst, filter, (b, u) => live(b, u, scale)]) {
        const r = await p(box, users);
        run.phases.push(r);
        console.log(
          `${scale} ${String(users).padStart(2)} users ${r.phase.padEnd(6)} ${String(r.requests).padStart(4)} req  p50 ${r.latency_ms.p50 ?? '—'} p95 ${r.latency_ms.p95 ?? '—'} ms  CPU mean ${r.server.cpu_mean_pct}% peak ${r.server.cpu_peak_pct}%  RAM ${r.server.mem_peak_mb} MB${r.errors.length ? `  ${r.errors.length} errors (${r.errors[0]})` : ''}`,
        );
      }
      results.runs.push(run);
    } finally {
      container.stop(box.name);
      rmSync(workDir, { recursive: true, force: true });
    }
    writeFileSync(join(outDir, 'load.json'), JSON.stringify(results, null, 2) + '\n');
  }
}
console.log(`\nresults: ${outDir}/load.json`);
