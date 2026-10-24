// Checks the transfer model against ../../../../shape (latency + bandwidth cap, no slow start).
// Serves a few precompressed thread bodies, fetches them through the proxy on a kept-alive
// connection, and compares time-to-last-byte with RTT + bytes / bandwidth.
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
const names = ['human-25', 'human-100', 'mix-50', 'agent-25', 'agent-100'];
const bodies = Object.fromEntries(names.map((n) => [n, zlib.brotliCompressSync(fs.readFileSync(`data/threads/${n}.json`), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })]));
const srv = http.createServer((q, r) => { const b = bodies[q.url.slice(1)] ?? Buffer.from('ok'); r.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br', 'content-length': b.length }); r.end(b); }).listen(18471, '127.0.0.1');
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const out = [];
for (const [rtt, down] of [[100, 10000], [20, 10000], [100, 50000]]) {
  const sh = spawn('/home/tomsj/dev/beghu/bench/shape', ['18472', '127.0.0.1:18471', '--rtt', String(rtt), '--down', String(down), '--up', '5000'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = (p) => new Promise((res) => { const t = performance.now(); http.get({ host: '127.0.0.1', port: 18472, path: p, agent }, (r) => { let n = 0; r.on('data', (c) => (n += c.length)); r.on('end', () => res([performance.now() - t, n])); }); });
  await get('/warm');
  for (const n of names) {
    const xs = []; let bytes = 0;
    for (let i = 0; i < 5; i++) { const [ms, b] = await get('/' + n); xs.push(ms); bytes = b; }
    const model = rtt + (bytes * 8) / (down * 1000) * 1000;
    out.push({ rtt, down_kbps: down, name: n, br4_bytes: bytes, measured_ms: +med(xs).toFixed(1), model_ms: +model.toFixed(1) });
    console.log(JSON.stringify(out.at(-1)));
  }
  agent.destroy(); sh.kill();
  await new Promise((r) => setTimeout(r, 300));
}
fs.writeFileSync('data/shapecheck.json', JSON.stringify(out, null, 1));
srv.close();
