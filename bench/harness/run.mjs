#!/usr/bin/env node
// ./bench/run <candidate>[:<variant>] [--profile low|fast] [--net near|far] [--scale 20k|50k] ...
// See bench/README.md for every flag and for the candidate contract.

import { chromium } from 'playwright';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { probe } from './probe.mjs';
import { Expect } from './expect.mjs';
import { scenarios } from './scenarios.mjs';
import { browserSampler, dockerStats, summarize, round } from './metrics.mjs';
import * as container from './container.mjs';
import { titleEdited } from '../fixture/github-shape.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROFILES = { fast: { cpu: 1 }, low: { cpu: 6 } };
const NETS = {
  near: { latency: 20, downloadThroughput: -1, uploadThroughput: -1 },
  far: { latency: 100, downloadThroughput: (10e6 / 8) | 0, uploadThroughput: (5e6 / 8) | 0 },
};
const SCALES = ['20k', '50k'];
const VIEWPORT = { width: 1280, height: 800 };

function parseArgs(argv) {
  const opts = { profile: 'low', net: 'far', scale: '20k', iterations: 20, scenarios: 'all', latency: 300, video: true, headed: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--headed') opts.headed = true;
    else if (a === '--no-video') opts.video = false;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  opts.candidate = rest[0];
  const list = (v, all) => (v === 'all' ? all : String(v).split(','));
  opts.profiles = list(opts.profile, Object.keys(PROFILES));
  opts.nets = list(opts.net, Object.keys(NETS));
  opts.scales = list(opts.scale, SCALES);
  opts.scenarioNames = list(opts.scenarios, scenarios.map((s) => s.name));
  opts.iterations = Number(opts.iterations);
  for (const p of opts.profiles) if (!PROFILES[p]) throw new Error(`unknown profile ${p}`);
  for (const n of opts.nets) if (!NETS[n]) throw new Error(`unknown net ${n}`);
  for (const s of opts.scales) if (!SCALES.includes(s)) throw new Error(`unknown scale ${s}`);
  for (const s of opts.scenarioNames) if (!scenarios.some((x) => x.name === s)) throw new Error(`unknown scenario ${s}`);
  return opts;
}

function hostInfo(browserVersion) {
  let cpu = cpus()[0]?.model ?? 'unknown';
  try {
    cpu = /Model name:\s*(.+)/.exec(execFileSync('lscpu', { encoding: 'utf8' }))[1].trim();
  } catch {}
  return {
    cpu,
    threads: cpus().length,
    ram_gb: round(totalmem() / 1e9),
    node: process.version,
    playwright: JSON.parse(readFileSync(join(root, 'node_modules/playwright/package.json'), 'utf8')).version,
    chromium: browserVersion,
    container_engine: execFileSync('docker', ['--version'], { encoding: 'utf8' }).trim(),
  };
}

async function runScenario(scenario, cell, opts, image, runDir) {
  const mirror = join(root, 'data', `mirror-${cell.scale}.db`);
  const expect = new Expect(mirror);
  const loadIds = expect.ids({});
  const fixtureDb = new DatabaseSync(mirror, { readOnly: true });
  const workDir = join(runDir, 'tmp', scenario.name);
  const box = await container.start({
    image,
    mirror,
    workDir,
    env: { GITHUB_LATENCY_MS: opts.latency, ...(opts.variant ? { BENCH_VARIANT: opts.variant } : {}) },
  });
  const stats = dockerStats(box.name);
  const browser = await chromium.launch({ channel: 'chromium', headless: !opts.headed });
  const sampler = browserSampler(browser);
  const videoDir = join(runDir, 'video', cell.id);

  const h = {
    url: box.url,
    expect,
    newContext: (video) =>
      browser.newContext({
        viewport: VIEWPORT,
        ...(video ? { recordVideo: { dir: videoDir, size: VIEWPORT } } : {}),
      }),
    async newPage(ctx, { armLoad = false } = {}) {
      const page = await ctx.newPage();
      await page.addInitScript(probe, { cpuRate: PROFILES[cell.profile].cpu, ...(armLoad ? { loadIds } : {}) });
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILES[cell.profile].cpu });
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, ...NETS[cell.net] });
      page.__cdp = cdp;
      await sampler.attach(page);
      return page;
    },
    // Sums JS bytes over the wire (encoded) and decoded, for scripts this page loads.
    trackScripts(page) {
      const scripts = new Map();
      page.__cdp.on('Network.responseReceived', (e) => e.type === 'Script' && scripts.set(e.requestId, { wire: 0, decoded: 0 }));
      page.__cdp.on('Network.dataReceived', (e) => scripts.has(e.requestId) && (scripts.get(e.requestId).decoded += e.dataLength));
      page.__cdp.on('Network.loadingFinished', (e) => scripts.has(e.requestId) && (scripts.get(e.requestId).wire = e.encodedDataLength));
      return async () => {
        const all = [...scripts.values()];
        return { files: all.length, wire_kb: round(all.reduce((a, s) => a + s.wire, 0) / 1024), decoded_kb: round(all.reduce((a, s) => a + s.decoded, 0) / 1024) };
      };
    },
    async webhookTitleEdit(id, title, updatedAt) {
      const { event, payload } = titleEdited(fixtureDb, id, title, updatedAt, 1000);
      const r = await fetch(`${box.url}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`webhook POST returned ${r.status}`);
    },
  };

  const samples = [];
  const errors = [];
  const state = {};
  const prime = async (ctx) => {
    const page = await h.newPage(ctx);
    await page.goto(h.url, { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__bench?.result, null, { timeout: 120_000, polling: 100 });
    await page.waitForTimeout(1000);
    await page.close();
  };

  try {
    let shared = null;
    let primed = true;
    if (!scenario.fresh) {
      shared = await h.newContext(false);
      // A failed prime fails this scenario, not the whole run.
      await prime(shared).catch((e) => {
        primed = false;
        errors.push(`prime: ${e.message.split('\n')[0]}`);
      });
    }
    for (let i = 0; primed && i < opts.iterations; i++) {
      const ctx = shared ?? (await h.newContext(false));
      try {
        samples.push(await scenario.iteration(h, ctx, i, state));
      } catch (e) {
        errors.push(`iteration ${i}: ${e.message.split('\n')[0]}`);
        if (errors.length >= 3 && samples.length === 0) break;
      } finally {
        if (!shared) await ctx.close();
      }
      process.stdout.write('.');
    }
    if (shared) await shared.close();

    if (opts.video && cell.profile === 'low' && samples.length) {
      const ctx = await h.newContext(true);
      const tabs = [];
      ctx.on('page', (p) => tabs.push(p));
      try {
        if (!scenario.fresh) await prime(ctx);
        await scenario.iteration(h, ctx, opts.iterations, state);
      } catch (e) {
        errors.push(`video pass: ${e.message.split('\n')[0]}`);
      }
      await ctx.close();
      // Keep the last tab, the one the scenario measured; the priming tab's video goes.
      const last = tabs.pop();
      await last?.video()?.saveAs(join(videoDir, `${scenario.name}.webm`));
      for (const p of [last, ...tabs]) await p?.video()?.delete();
    }
  } catch (e) {
    errors.push(`aborted: ${e.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
  const server = stats.stop();
  const memory = await sampler.stop();
  if (errors.length) errors.push(`container log tail:\n${container.logs(box.name)}`);
  container.stop(box.name);
  rmSync(workDir, { recursive: true, force: true });
  fixtureDb.close();

  const flat = (key) => samples.flatMap((s) => s[key] ?? []);
  const result = {
    scenario: scenario.name,
    iterations: samples.length,
    errors,
    server,
    memory,
  };
  if (scenario.name === 'scroll') {
    const long = flat('longTasks');
    result.frame_ms = summarize(flat('frames'));
    result.long_tasks = { count: long.length, over_100ms: long.filter((d) => d > 100).length, max_ms: round(long.length ? Math.max(...long) : 0) };
    result.reach_ms = summarize(flat('reach_ms'));
  } else {
    result.latency_ms = summarize(flat('latency'));
  }
  if (scenario.name === 'filter' || scenario.name === 'early') {
    // Per step kind ("label", "search", or "early search" / "later label" for early), and per
    // answerer (server or local cache, see timedStep in scenarios.mjs).
    const byKind = {};
    const byAnswer = {};
    const words = scenario.name === 'early' ? 2 : 1;
    for (const s of samples.flatMap((x) => x.steps)) {
      (byKind[s.step.split(' ').slice(0, words).join(' ')] ??= []).push(s.ms);
      (byAnswer[s.by] ??= []).push(s.ms);
    }
    const sum = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, summarize(v)]));
    result.steps = sum(byKind);
    result.answered_by = sum(byAnswer);
  }
  if (scenario.name === 'warm' && flat('cache_ready_ms').length) result.cache_ready_ms = summarize(flat('cache_ready_ms'));
  if (scenario.name === 'early') {
    if (flat('cache_ready_ms').length) result.cache_ready_ms = summarize(flat('cache_ready_ms'));
    result.switched = { same: samples.filter((s) => s.switched === 'same').length, differs: samples.filter((s) => s.switched === 'differs').length };
  }
  if (scenario.name === 'write') result.roundtrip_ms = summarize(flat('roundtrip_ms'));
  if (scenario.name === 'cold') {
    if (flat('cache_warm_ms').length) result.cache_warm_ms = summarize(flat('cache_warm_ms'));
    if (flat('cache_ready_ms').length) result.cache_ready_ms = summarize(flat('cache_ready_ms'));
    const js = samples.map((s) => s.js).filter(Boolean);
    const med = (k) => summarize(js.map((j) => j[k])).p50;
    result.js = { files: js[0]?.files ?? 0, wire_kb: med('wire_kb'), decoded_kb: med('decoded_kb') };
  }
  return result;
}

function verdict(scenario, r) {
  const ref = scenario.reference;
  if (scenario.name === 'scroll') {
    if (!r.frame_ms?.n) return { ref: `≤ ${ref.frameMs} ms frames, no long task > ${ref.longTaskMs} ms`, ok: null };
    return { ref: `≤ ${ref.frameMs} ms frames, no long task > ${ref.longTaskMs} ms`, ok: r.frame_ms.p95 <= ref.frameMs && r.long_tasks.over_100ms === 0 };
  }
  return { ref: `≤ ${ref.ms} ms`, ok: r.latency_ms?.n ? r.latency_ms.p95 <= ref.ms : null };
}

function markdown(run) {
  const lines = [`# ${run.candidate} — ${run.started}`, '', `Host: ${run.host.cpu} (${run.host.threads} threads, ${run.host.ram_gb} GB), ${run.host.chromium}, ${run.host.container_engine}`, ''];
  for (const cell of run.cells) {
    lines.push(`## ${cell.id}${cell.id === 'low-far-20k' ? ' (headline)' : ''}`, '');
    lines.push('| Scenario | n | p50 | p95 | Reference (p95) | Server CPU mean/peak | Server RAM peak | JS heap peak | Tab PSS peak | Notes |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of cell.results) {
      const s = scenarios.find((x) => x.name === r.scenario);
      const v = verdict(s, r);
      const m = r.frame_ms ?? r.latency_ms ?? {};
      const mark = v.ok == null ? '—' : v.ok ? '✓' : '✗';
      const notes = [];
      if (r.cache_warm_ms) notes.push(`cache warm p50 ${r.cache_warm_ms.p50} / p95 ${r.cache_warm_ms.p95} ms`);
      if (r.cache_ready_ms) notes.push(`cache ready p50 ${r.cache_ready_ms.p50} / p95 ${r.cache_ready_ms.p95} ms`);
      if (r.answered_by) notes.push(Object.entries(r.answered_by).map(([k, v]) => `${k} n ${v.n} p95 ${v.p95}`).join(', '));
      if (r.switched) notes.push(`switchover rows same ${r.switched.same}, differ ${r.switched.differs}`);
      if (r.js) notes.push(`JS ${r.js.wire_kb} KB wire / ${r.js.decoded_kb} KB decoded in ${r.js.files} files`);
      if (r.long_tasks) notes.push(`${r.long_tasks.count} long tasks, ${r.long_tasks.over_100ms} > 100 ms, max ${r.long_tasks.max_ms} ms; reached row 500 in p50 ${r.reach_ms.p50} ms`);
      if (r.roundtrip_ms) notes.push(`server round trip p50 ${r.roundtrip_ms.p50} / p95 ${r.roundtrip_ms.p95} ms`);
      if (r.steps) notes.push(Object.entries(r.steps).map(([k, v]) => `${k} p95 ${v.p95}`).join(', '));
      if (r.errors.length) notes.push(`**${r.errors.length - 1} errors**`);
      lines.push(
        `| ${s.title} | ${r.iterations} | ${m.p50 ?? '—'} | ${m.p95 ?? '—'} | ${mark} ${v.ref} | ${r.server.cpu_mean_pct ?? '—'}% / ${r.server.cpu_peak_pct ?? '—'}% | ${r.server.mem_peak_mb ?? '—'} MB | ${r.memory.js_heap_peak_mb} MB | ${r.memory.tab_pss_peak_mb} MB | ${notes.join('; ')} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.candidate) {
    console.error('usage: ./bench/run <candidate>[:<variant>] [--profile low|fast|all] [--net near|far|all] [--scale 20k|50k|all] [--iterations 20] [--scenarios cold,warm,...] [--latency 300] [--no-video] [--headed]');
    process.exit(2);
  }
  // `<dir>:<variant>` builds one candidate directory and starts it with BENCH_VARIANT=<variant>.
  const [dir, variant] = opts.candidate.split(':');
  opts.variant = variant;
  const candidateDir = join(root, 'candidates', dir);
  if (!existsSync(join(candidateDir, 'Dockerfile'))) throw new Error(`no Dockerfile in ${candidateDir}`);
  for (const scale of opts.scales) {
    if (!existsSync(join(root, 'data', `mirror-${scale}.db`))) {
      console.log(`generating the ${scale} fixture...`);
      execFileSync(process.execPath, [join(root, 'fixture/generate.mjs'), '--scale', scale], { stdio: 'inherit' });
    }
  }

  const image = `beghu-bench-${dir}`;
  console.log(`building ${image}...`);
  container.build(candidateDir, image);

  const started = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runDir = join(root, 'results', `${started.replace(/[:]/g, '').replace('T', '-').slice(0, 17)}-${opts.candidate.replace(':', '-')}`);
  mkdirSync(runDir, { recursive: true });

  const probeBrowser = await chromium.launch({ channel: 'chromium' });
  const run = { candidate: opts.candidate, started, options: { iterations: opts.iterations, latency_ms: opts.latency }, host: hostInfo(probeBrowser.version()), cells: [] };
  await probeBrowser.close();

  const selected = scenarios.filter((s) => opts.scenarioNames.includes(s.name));
  for (const profile of opts.profiles)
    for (const net of opts.nets)
      for (const scale of opts.scales) {
        const cell = { id: `${profile}-${net}-${scale}`, profile, net, scale, results: [] };
        run.cells.push(cell);
        console.log(`\n${cell.id}`);
        for (const scenario of selected) {
          process.stdout.write(`  ${scenario.name.padEnd(7)} `);
          const r = await runScenario(scenario, cell, opts, image, runDir);
          cell.results.push(r);
          const m = r.frame_ms ?? r.latency_ms;
          const v = verdict(scenario, r);
          console.log(` p50 ${m?.p50 ?? '—'}  p95 ${m?.p95 ?? '—'} ms  ${v.ok == null ? '—' : v.ok ? 'within' : 'over'} ${v.ref}${r.errors.length ? `  (${r.errors.length - 1} errors)` : ''}`);
          for (const e of r.errors.slice(0, 3)) console.log(`    ${e.split('\n')[0]}`);
          writeFileSync(join(runDir, 'results.json'), JSON.stringify(run, null, 2) + '\n');
        }
      }
  writeFileSync(join(runDir, 'summary.md'), markdown(run) + '\n');
  console.log(`\nresults: ${runDir}/summary.md`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
