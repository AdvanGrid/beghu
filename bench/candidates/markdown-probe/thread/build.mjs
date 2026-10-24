// Builds the comment pools and the N-comment threads, renders them through the Rust server path
// (comrak -> ammonia -> compact AST), and records server time, wire bytes and compression cost.
// Writes data/threads/<class>-<N>.json (the response body) and data/build.json (all numbers).
// Run from this directory: node build.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const BIN = 'rs/target/release/thread-probe';
const NS = [2, 5, 10, 25, 50, 100, 200, 400, 800];
fs.mkdirSync('data/threads', { recursive: true });
const bytes = (s) => Buffer.byteLength(s);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// seeded shuffle so threads are reproducible
let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

const corpus = JSON.parse(fs.readFileSync('../github/data/corpus.json', 'utf8'));
const human = corpus.flatMap((t, ti) => t.comments.map((c, i) => ({ md: c.body ?? '', author: `user${(ti * 977 + i * 31) % 4000}`, src: `${t.repo}#${t.number}` })));
const agent = JSON.parse(fs.readFileSync('data/agents.json', 'utf8')).map((c) => ({ md: c.body, author: c.login, src: c.src }));
const kandev = JSON.parse(fs.readFileSync('data/kandev-2669.json', 'utf8')).map((c) => ({ md: c.body, author: c.login, src: c.src, created_at: c.created_at }));

// per-comment compact AST from the Rust path, for every pool comment
const all = [...human, ...agent, ...kandev];
fs.writeFileSync('data/pool-md.json', JSON.stringify(all.map((c) => c.md)));
const asts = JSON.parse(execFileSync(BIN, ['asts', 'data/pool-md.json'], { maxBuffer: 1 << 30 }).toString());
all.forEach((c, i) => { c.ast = asts[i]; c.astBytes = bytes(JSON.stringify(asts[i])); c.mdBytes = bytes(c.md); });

const dist = (pool) => { const m = pool.map((c) => c.mdBytes), a = pool.map((c) => c.astBytes); return { n: pool.length, md_median: q(m, 0.5), md_p90: q(m, 0.9), md_mean: Math.round(m.reduce((x, y) => x + y, 0) / m.length), md_max: Math.max(...m), ast_median: q(a, 0.5), ast_p90: q(a, 0.9), ast_mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length) }; };
const pools = { human: dist(human), agent: dist(agent), kandev: dist(kandev) };
console.log('pool size distribution (bytes):', pools);

const H = shuffle(human), A = shuffle(agent);
const pick = { human: (i) => H[i % H.length], agent: (i) => A[i % A.length], mix: (i) => (i % 2 ? A[(i >> 1) % A.length] : H[(i >> 1) % H.length]) };
const t0 = Date.parse('2025-01-01T00:00:00Z');
const response = (items) => JSON.stringify(items.map((c, i) => ({ id: 3000000000 + i * 7919, author: c.author, created_at: c.created_at ?? new Date(t0 + i * 3_600_000 * 7).toISOString().replace('.000', ''), body: c.ast })));

const cases = [];
for (const cls of ['human', 'agent', 'mix']) for (const n of NS) cases.push({ cls, n, items: Array.from({ length: n }, (_, i) => pick[cls](i)) });
cases.push({ cls: 'kandev', n: kandev.length, items: kandev });

const time = (f, reps = 7) => { const xs = []; let r; for (let i = 0; i < reps; i++) { const t = process.hrtime.bigint(); r = f(); xs.push(Number(process.hrtime.bigint() - t) / 1e6); } return [q(xs, 0.5), r]; };
const out = [];
for (const c of cases) {
  const name = `${c.cls}-${c.n}`;
  const body = response(c.items);
  fs.writeFileSync(`data/threads/${name}.json`, body);
  fs.writeFileSync('data/tmp-md.json', JSON.stringify(c.items.map((x) => x.md)));
  const srv = JSON.parse(execFileSync(BIN, ['time', 'data/tmp-md.json', c.n > 200 ? '7' : '15']).toString());
  const buf = Buffer.from(body);
  const [gz6ms, gz6] = time(() => zlib.gzipSync(buf, { level: 6 }).length);
  const [br4ms, br4] = time(() => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }).length);
  const [br5ms, br5] = time(() => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }).length);
  const [gunzipMs] = time(() => zlib.gunzipSync(zlib.gzipSync(buf, { level: 6 })).length, 1);
  const mdBytes = c.items.reduce((s, x) => s + x.mdBytes, 0);
  const row = { name, cls: c.cls, n: c.n, md: mdBytes, raw: buf.length, gz6, br4, br5, srv_ms: srv.total_med, comrak_ms: srv.comrak, ammonia_ms: srv.ammonia, ast_ms: srv.ast, gz6_ms: gz6ms, br4_ms: br4ms, br5_ms: br5ms };
  out.push(row);
  console.log(JSON.stringify(row));
}
fs.rmSync('data/tmp-md.json');
fs.writeFileSync('data/build.json', JSON.stringify({ pools, rows: out }, null, 1));
