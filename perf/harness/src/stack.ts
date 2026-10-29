// A stack the gates run against, as production runs it: beghu's release binary serving the
// production web build (compression, the cached shell, the hashed assets), with Fake GitHub's
// release binary behind it, both on fresh ports. Fake GitHub's webhooks pass through a relay
// here, which notes when each reaches beghu: the live gates time from there.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { sleep } from "./stats.ts";

/** A built tree: its release binaries (`beghu`, `fake-github`, `fixture`) and its web build. */
export interface Build {
  bin: string;
  web: string;
  /** The commit it was built from, for the results. */
  commit: string;
}

export const ROOT = resolve(import.meta.dirname, "../../..");
/** Where fixtures go, named by their generator's hash: shared by every build. */
export const FIXTURES = join(ROOT, "perf", "data");
/** The limits, owner-reviewed (CODEOWNERS). */
export const BUDGETS = join(ROOT, "perf-budgets.toml");

/** The dev App and secrets the dev stack uses too (tools/dev-ctl/src/config.ts). Dev data only. */
const DEV = {
  clientId: "Iv1.fakegithub",
  clientSecret: "fake-github-secret",
  webhookSecret: "fake-github-webhook-secret",
  appId: "1000001",
  appSlug: "beghu-dev",
  tokenKey: "ZGV2LW9ubHkgYmVnaHUgdG9rZW4ga2V5LCBub3QgYSBzZWNyZXQ=",
};

/**
 * The fixture at `scale` for this build's generator, generated the first time into `dir` (which
 * keeps only the latest generator's fixtures).
 */
export function fixtureFor(build: Build, scale: string, dir = FIXTURES): string {
  const gen = spawnSync(join(build.bin, "fixture"), ["--scale", scale, "--out", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const path = gen.stdout.trim().split("\n").at(-1);
  if (gen.status !== 0 || !path) throw new Error(`the ${scale} fixture generator failed`);
  return path;
}

/**
 * Pristine data for `fixture` in `dir` (Fake GitHub's truth and the accounts' mirrors), kept
 * between runs while the fixture is the same and `fresh` isn't asked for.
 */
export function seed(build: Build, fixture: string, dir: string, fresh: boolean): void {
  const mark = join(dir, "seeded.json");
  if (!fresh && existsSync(mark) && JSON.parse(readFileSync(mark, "utf8")).fixture === fixture) {
    // A previous run's sessions and control DB go; the data stays.
    for (const f of ["control.db", "control.db-wal", "control.db-shm", "backups", "assets", "builds"]) rmSync(join(dir, f), { recursive: true, force: true });
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(join(build.bin, "fake-github"), ["pristine-mirrors", "--fixture", fixture, "--db", join(dir, "fake", "truth.db"), "--dir", join(dir, "mirrors")], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (r.status !== 0) throw new Error("seeding the mirrors failed");
  writeFileSync(mark, JSON.stringify({ fixture }) + "\n");
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => done(port));
    });
  });
}

/** A webhook delivery as it reached beghu. */
export interface Delivery {
  event: string;
  /** `Date.now()` as it was handed to beghu. */
  at: number;
  body: string;
}

export interface Stack {
  label: string;
  build: Build;
  fixture: string;
  /** beghu, as browsers reach it. */
  url: string;
  control: string;
  deliveries: Delivery[];
  /** beghu's log lines (its `scan steps:` lines name the statements behind a scan count). */
  log: string[];
  stop(): Promise<void>;
}

/** Starts Fake GitHub and beghu on `data` (seeded) and waits until beghu is ready. */
export async function start(label: string, build: Build, fixture: string, data: string, logFile: string): Promise<Stack> {
  const [server, fake, control, relay] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const url = `http://localhost:${server}`;
  const out = createWriteStream(logFile, { flags: "w" });
  const log: string[] = [];
  const deliveries: Delivery[] = [];

  // The relay: Fake GitHub posts here, and the delivery goes on to beghu as it came.
  const relayServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const at = Date.now();
      deliveries.push({ event: String(req.headers["x-github-event"] ?? ""), at, body: body.toString("utf8") });
      const fwd = httpRequest(`http://127.0.0.1:${server}/webhook`, { method: "POST", headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      fwd.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      fwd.end(body);
    });
  });
  await new Promise<void>((r) => relayServer.listen(relay, "127.0.0.1", r));

  const procs: ChildProcess[] = [];
  const run = (name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    procs.push(child);
    pipeLines(child, name, out, name === "server" ? log : undefined);
    return child;
  };
  run("fake", join(build.bin, "fake-github"), [
    "serve",
    "--fixture", fixture,
    "--db", join(data, "fake", "truth.db"),
    "--port", String(fake),
    "--control-port", String(control),
    "--client-id", DEV.clientId,
    "--client-secret", DEV.clientSecret,
    "--webhook-url", `http://127.0.0.1:${relay}/webhook`,
    "--webhook-secret", DEV.webhookSecret,
    "--setup-url", `${url}/auth/setup`,
  ], {});
  run("server", join(build.bin, "beghu"), [], {
    PORT: String(server),
    BEGHU_BUILD_ID: `perf-${label}`,
    BEGHU_PUBLIC_URL: url,
    BEGHU_DATA_DIR: data,
    BEGHU_WEB_DIR: build.web,
    BEGHU_TOKEN_KEY: DEV.tokenKey,
    BEGHU_SCAN_STEPS: "1",
    GITHUB_API_URL: `http://127.0.0.1:${fake}`,
    GITHUB_WEB_URL: `http://127.0.0.1:${fake}`,
    GITHUB_CLIENT_ID: DEV.clientId,
    GITHUB_CLIENT_SECRET: DEV.clientSecret,
    GITHUB_WEBHOOK_SECRET: DEV.webhookSecret,
    GITHUB_APP_ID: DEV.appId,
    GITHUB_APP_SLUG: DEV.appSlug,
    GITHUB_APP_PRIVATE_KEY_FILE: join(ROOT, "crates", "fake-github", "src", "dev-app-key.pem"),
    GITHUB_ATTACHMENTS_URL: `http://127.0.0.1:${fake}/private-user-images`,
    BEGHU_DEV_IMAGE_HOSTS: `127.0.0.1:${fake}`,
    RUST_LOG: "warn",
  });

  const stop = async () => {
    for (const p of procs) if (p.exitCode === null) p.kill("SIGTERM");
    await Promise.all(procs.map((p) => (p.exitCode === null ? new Promise((r) => p.once("exit", r)) : null)));
    await new Promise((r) => relayServer.close(r));
    out.end();
  };
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (procs.some((p) => p.exitCode !== null)) {
      await stop();
      throw new Error(`${label}: a process exited while starting; see ${logFile}`);
    }
    if ((await text(`${url}/readyz`)) === "ready" && (await text(`http://127.0.0.1:${control}/state`)) !== null) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`${label}: not ready within 120 s; see ${logFile}`);
    }
    await sleep(200);
  }
  return { label, build, fixture, url, control: `http://127.0.0.1:${control}`, deliveries, log, stop };
}

async function text(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return r.ok ? (await r.text()).trim() : null;
  } catch {
    return null;
  }
}

function pipeLines(child: ChildProcess, name: string, out: WriteStream, keep?: string[]): void {
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) {
        out.write(`[${name}] ${l}\n`);
        keep?.push(l);
      }
    });
  }
}

/** A call to Fake GitHub's control port (an outside edit, say). */
export async function control(stack: Stack, method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(stack.control + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`fake ${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** The `scan steps:` lines beghu logged for `path` (a request's path and query). */
export function scanEvidence(stack: Stack, path: string): string[] {
  const at = ` in GET ${path}: `;
  return [...new Set(stack.log.filter((l) => l.startsWith("scan steps:") && l.includes(at)).map((l) => l.replace(at, ": ").slice(0, 300)))].sort(
    (x, y) => steps(y) - steps(x),
  );
}

const steps = (line: string) => Number(/^scan steps: (\d+)/.exec(line)?.[1] ?? 0);
