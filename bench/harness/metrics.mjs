import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function summarize(values) {
  return {
    n: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    max: round(values.length ? Math.max(...values) : null),
  };
}

export const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

const UNITS = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3 };
function parseBytes(s) {
  const m = /^([\d.]+)\s*([a-z]+)$/i.exec(String(s).trim());
  return m ? Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 1) : NaN;
}

// Streams `docker stats` for one container. Handles both Docker's JSON (strings like "12.3%" and
// "40MiB / 512MiB") and Podman's (numbers).
export function dockerStats(container) {
  const samples = [];
  // Podman reports every 5 s unless told otherwise; Docker has no flag and reports about every 1 s.
  const podman = /podman/i.test(execFileSync('docker', ['--version'], { encoding: 'utf8' }));
  const args = ['stats', '--format', '{{json .}}', ...(podman ? ['--interval', '1'] : []), container];
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.slice(raw.indexOf('{'));
      if (!line) continue;
      try {
        const s = JSON.parse(line);
        const cpu = typeof s.CPU === 'number' ? s.CPU : parseFloat(s.CPUPerc);
        const mem = typeof s.MemUsage === 'number' ? s.MemUsage : parseBytes(String(s.MemUsage).split('/')[0]);
        const pids = Number(s.PIDs ?? s.PIDS);
        if (Number.isFinite(cpu) && Number.isFinite(mem)) samples.push({ t: Date.now(), cpu, mem, pids });
      } catch {}
    }
  });
  return {
    stop() {
      child.kill();
      const cpu = samples.map((s) => s.cpu);
      const mem = samples.map((s) => s.mem / 1e6);
      return {
        samples: samples.length,
        cpu_mean_pct: round(cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1)),
        cpu_peak_pct: round(cpu.length ? Math.max(...cpu) : null),
        mem_peak_mb: round(mem.length ? Math.max(...mem) : null),
        // Threads in the container (Docker's PIDs column counts threads), where the runtime reports it.
        threads_peak: samples.some((s) => Number.isFinite(s.pids)) ? Math.max(...samples.map((s) => s.pids).filter(Number.isFinite)) : null,
      };
    },
  };
}

// Samples the JS heap of the current page (CDP Performance.getMetrics) and the memory of the
// tab's renderer process (PSS from /proc, Linux only) every 250 ms.
export function browserSampler(browser) {
  let page = null;
  let session = null;
  let heapPeak = 0;
  let pssPeak = 0;
  let browserSession = null;
  let stopped = false;

  const tick = async () => {
    try {
      if (session) {
        const { metrics } = await session.send('Performance.getMetrics');
        const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
        heapPeak = Math.max(heapPeak, heap);
      }
      browserSession ??= await browser.newBrowserCDPSession();
      const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
      for (const p of processInfo.filter((p) => p.type === 'renderer')) {
        try {
          const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${p.id}/smaps_rollup`, 'utf8'));
          if (m) pssPeak = Math.max(pssPeak, Number(m[1]) * 1024);
        } catch {}
      }
    } catch {}
  };
  const timer = setInterval(() => !stopped && tick(), 250);

  return {
    async attach(p) {
      page = p;
      session = await p.context().newCDPSession(p);
      await session.send('Performance.enable');
      p.once('close', () => {
        if (page === p) session = null;
      });
    },
    async stop() {
      await tick();
      stopped = true;
      clearInterval(timer);
      return { js_heap_peak_mb: round(heapPeak / 1e6), tab_pss_peak_mb: round(pssPeak / 1e6) };
    },
  };
}
