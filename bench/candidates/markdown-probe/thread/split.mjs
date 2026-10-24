// What a byte-budgeted first response holds: body (item 0) + newest comments that fit BUDGET raw
// bytes of JSON, and its brotli-4 / gzip-6 size. Usage: node split.mjs [budget=36000]
import fs from 'node:fs';
import zlib from 'node:zlib';
const BUDGET = +(process.argv[2] ?? 36000);
for (const f of fs.readdirSync('data/threads').sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
  const d = JSON.parse(fs.readFileSync(`data/threads/${f}`));
  const s = d.map((x) => Buffer.byteLength(JSON.stringify(x)) + 1);
  let used = s[0], n = 0;
  for (let i = d.length - 1; i > 0 && (n === 0 || used + s[i] <= BUDGET); i--) { used += s[i]; n++; }
  const txt = JSON.stringify([d[0], ...d.slice(d.length - n)]);
  const br = zlib.brotliCompressSync(txt, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }).length;
  console.log(`${f.replace('.json', '')}: first + newest ${n} of ${d.length - 1}, raw ${txt.length}, br4 ${br}, gz6 ${zlib.gzipSync(txt, { level: 6 }).length}`);
}
