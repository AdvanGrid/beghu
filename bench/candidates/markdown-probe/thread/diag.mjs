// Splits the agent pool by script (English vs Chinese-heavy) to see what drives layout cost.
// Writes data/threads/agentEN-<N>.json and agentZH-<N>.json for N = 50, 100.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const agent = JSON.parse(fs.readFileSync('data/agents.json', 'utf8'));
const cjk = (s) => (s.match(/[　-鿿]/g) ?? []).length / s.length;
const en = agent.filter((c) => cjk(c.body) < 0.01), zh = agent.filter((c) => cjk(c.body) >= 0.1);
console.log('en', en.length, 'zh', zh.length);
for (const [name, pool] of [['agentEN', en], ['agentZH', zh]]) {
  fs.writeFileSync('data/tmp-md.json', JSON.stringify(pool.map((c) => c.body)));
  const asts = JSON.parse(execFileSync('rs/target/release/thread-probe', ['asts', 'data/tmp-md.json'], { maxBuffer: 1 << 30 }).toString());
  for (const n of [50, 100]) {
    const items = Array.from({ length: n }, (_, i) => ({ id: 3000000000 + i * 7919, author: pool[i % pool.length].login, created_at: pool[i % pool.length].created_at, body: asts[i % pool.length] }));
    fs.writeFileSync(`data/threads/${name}-${n}.json`, JSON.stringify(items));
    const b = Buffer.byteLength(JSON.stringify(items)); console.log(name, n, b);
  }
}
fs.rmSync('data/tmp-md.json');
