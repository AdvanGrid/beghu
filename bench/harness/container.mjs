import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const LIMITS = ['--cpus=1', '--memory=512m'];

export function build(candidateDir, image) {
  const r = spawnSync('docker', ['build', '-q', '-t', image, candidateDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker build failed for ${candidateDir}:\n${r.stdout}\n${r.stderr}`);
}

export function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Starts the candidate on a fresh copy of the fixture mirror, mounted at /data/mirror.db.
export async function start({ image, mirror, workDir, env = {} }) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  copyFileSync(mirror, join(workDir, 'mirror.db'));
  const port = await freePort();
  const name = `beghu-bench-${process.pid}-${Date.now().toString(36)}`;
  const envArgs = Object.entries({ MIRROR_PATH: '/data/mirror.db', PORT: '8080', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, ...LIMITS, '-p', `127.0.0.1:${port}:8080`, '-v', `${workDir}:/data`, ...envArgs, image], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy(url, name);
  return { name, url };
}

async function waitHealthy(url, name, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const logs = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' });
  stop(name);
  throw new Error(`${name} never answered /healthz within ${timeoutMs / 1000} s:\n${logs.stdout}${logs.stderr}`);
}

export function logs(name) {
  const r = spawnSync('docker', ['logs', '--tail', '40', name], { encoding: 'utf8' });
  return r.stdout + r.stderr;
}

export function stop(name) {
  spawnSync('docker', ['kill', name], { stdio: 'ignore' });
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
