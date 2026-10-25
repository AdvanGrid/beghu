// PROTOTYPE (beghu #68). Renders real GitHub threads plus kitchen-sink.md through the decided server
// path (comrak -> ammonia -> compact AST, the markdown probe's thread-probe binary) into
// web/public/md-corpus.json, which the detail swaps in for the fixture's lorem bodies.
//
//   node md-corpus/build.mjs   (from list-prototype/; PROBE= points at the markdown probe)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const probe = process.env.PROBE ?? '/home/tomsj/dev/beghu/bench/candidates/markdown-probe';
const bin = join(probe, 'thread/rs/target/release/thread-probe');
const PAGE = 15;

const threads = [];
threads.push({ key: 'headings', title: 'Headings: down and back up', repo: 'tomsjansons/beghu', body: readFileSync(join(here, 'headings.md'), 'utf8'), comments: [] });
threads.push({ key: 'kitchen', title: 'Kitchen sink: every element', repo: 'tomsjansons/beghu', body: readFileSync(join(here, 'kitchen-sink.md'), 'utf8'), comments: [] });

for (const name of ['vitejs_vite-11468', 'tokio-rs_tokio-1879', 'rust-lang_rust-38356', 'nodejs_node-37061', 'oven-sh_bun-15087', 'microsoft_vscode-336320']) {
  const i = JSON.parse(readFileSync(join(probe, `github/data/${name}.issue.json`), 'utf8'));
  const cs = JSON.parse(readFileSync(join(probe, `github/data/${name}.comments.json`), 'utf8'));
  threads.push({
    key: name,
    title: i.title,
    repo: name.replace('_', '/').replace(/-\d+$/, ''),
    body: i.body ?? '',
    comments: cs.filter((c) => c.body?.trim()).slice(0, PAGE).map((c) => ({ author: c.user?.login ?? 'ghost', created_at: c.created_at, body: c.body })),
  });
}

// Agent threads: long bot comments with headings, tables, task lists and details.
const agents = JSON.parse(readFileSync(join(probe, 'thread/data/agents.json'), 'utf8'));
for (const src of [...new Set(agents.map((a) => a.src))]) {
  const cs = agents.filter((a) => a.src === src);
  threads.push({
    key: `agent:${src}`,
    title: `Agent thread: ${src}`,
    repo: src.replace('_', '/').replace(/-\d+$/, ''),
    body: cs[0].body,
    comments: cs.slice(1, 1 + PAGE).map((c) => ({ author: c.login, created_at: c.created_at, body: c.body })),
  });
}

const docs = threads.flatMap((t) => [t.body, ...t.comments.map((c) => c.body)]);
const tmp = join(mkdtempSync(join(tmpdir(), 'md-corpus-')), 'docs.json');
writeFileSync(tmp, JSON.stringify(docs));
const asts = JSON.parse(execFileSync(bin, ['asts', tmp], { maxBuffer: 1 << 28 }).toString());
let k = 0;
const out = threads.map((t) => ({
  key: t.key,
  title: t.title,
  repo: t.repo,
  body: asts[k++],
  comments: t.comments.map((c) => ({ author: c.author, created_at: c.created_at, ast: asts[k++] })),
}));
writeFileSync(join(here, '../web/public/md-corpus.json'), JSON.stringify(out));
console.log(`${out.length} threads, ${docs.length} docs`);
