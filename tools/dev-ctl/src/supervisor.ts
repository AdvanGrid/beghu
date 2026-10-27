// The background process `start` leaves running. It builds, seeds the data, runs Fake GitHub, the
// beghu server and Vite, writes their output to one log with a prefix per process, and rebuilds
// and restarts the Rust processes when their sources change. A process that exits on its own is
// restarted with backoff; one that keeps failing fast is given up on, and the stack's phase says
// so. SIGTERM stops everything.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, statSync, watch } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  CLIENT,
  DATA,
  DEV_TOKEN_KEY,
  DEV_WEBHOOK_SECRET,
  FAKE_DB,
  FIXTURES,
  LOG,
  MIRRORS,
  PID,
  PORTS,
  ROOT,
  type Scale,
  SEEDED,
  STATE,
  type State,
  TARGET,
  URLS,
  type FakeState,
  fakeState,
  readJson,
  remove,
  writeJson,
} from "./config.ts";

type Proc = "fake" | "server" | "vite";

const BINARIES = { fake: join(TARGET, "fake-github"), server: join(TARGET, "beghu") };

function log(prefix: string, line: string): void {
  // Strip ANSI escapes so the log reads well in tools.
  const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  appendFileSync(LOG, `[${prefix}] ${clean}\n`);
}

/** Pipes a child's stdout and stderr into the log, line by line, under `prefix`. */
function capture(child: ChildProcess, prefix: string, onLine?: (line: string) => void): void {
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        log(prefix, line);
        onLine?.(line);
      }
    });
    stream?.on("end", () => {
      if (rest) log(prefix, rest);
    });
  }
}

/** Runs a command to completion, logging its output; resolves to its exit code and stdout. */
function run(cmd: string, args: string[], prefix: string): Promise<{ code: number; stdout: string[] }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => stdout.push(...c.split("\n").filter(Boolean)));
    capture(child, prefix);
    child.on("error", (e) => {
      log(prefix, `can't run ${cmd}: ${e.message}`);
      done({ code: 127, stdout });
    });
    child.on("exit", (code) => done({ code: code ?? 1, stdout }));
  });
}

const build = () => run("cargo", ["build", "-p", "beghu", "-p", "fake-github"], "cargo");

export async function supervise(scale: Scale): Promise<void> {
  const state: State = {
    pid: process.pid,
    mode: "fixture",
    scale,
    fixture: null,
    phase: "starting",
    urls: URLS,
    startedAt: new Date().toISOString(),
  };
  const save = () => writeJson(STATE, state);
  const fail = (error: string): never => {
    log("dev-ctl", error);
    state.phase = "failed";
    state.error = error;
    save();
    process.exit(1);
  };
  writeJson(PID, process.pid);
  save();

  const busy = await busyPort();
  if (busy) return fail(busy);
  log("dev-ctl", "building the server and Fake GitHub");
  if ((await build()).code !== 0) return fail("the build failed; see the [cargo] lines above");
  const fixture = await generateFixture(scale);
  if (!fixture) return fail("the fixture generator failed");
  state.fixture = fixture;
  save();
  if (!(await seedMirrors(scale, fixture))) return fail("seeding the mirrors failed");

  const stack = processes(fixture, {
    started: (name, pid) => {
      state.children = { ...state.children, [name]: pid };
      save();
    },
    gaveUp: (name, why) => {
      log("dev-ctl", why);
      state.phase = "failed";
      state.error = why;
      state.failed = name;
      save();
    },
    recovered: (name) => {
      if (state.failed !== name) return;
      log("dev-ctl", `${name} is up again`);
      state.phase = "ready";
      delete state.error;
      delete state.failed;
      save();
    },
  });
  const shutdown = async () => {
    if (!stack.beginStopping()) return;
    log("dev-ctl", "stopping");
    await stack.stopAll();
    remove(STATE);
    remove(PID);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  stack.startAll();
  const ready = await waitUntilUp(60_000, stack.running);
  if (ready !== true) {
    await stack.stopAll();
    return fail(`${ready} didn't come up; see its lines in the log`);
  }
  state.phase = "ready";
  save();
  log("dev-ctl", `ready: app ${URLS.app}, server ${URLS.server}, fake ${URLS.fake}`);

  let startupTokens = (await fakeState(URLS.control))?.tokens;
  watchSources(async () => {
    startupTokens = await rebuildAndRestart(stack, startupTokens);
  });
}

/** Why the stack can't start because a port it needs is taken, or null when all are free. */
async function busyPort(): Promise<string | null> {
  const ports: [Proc, number, string][] = [
    ["fake", PORTS.fake, "DEV_FAKE_PORT"],
    ["fake", PORTS.control, "DEV_FAKE_CONTROL_PORT"],
    ["server", PORTS.server, "DEV_SERVER_PORT"],
    ["vite", PORTS.app, "DEV_APP_PORT"],
  ];
  for (const [name, port, env] of ports) {
    if (!(await portFree(port))) return `port ${port} (${name}) is already in use; free it or set ${env}`;
  }
  return null;
}

/** The fixture's path, generating it the first time; null when the generator fails. */
async function generateFixture(scale: Scale): Promise<string | null> {
  log("dev-ctl", `generating the ${scale} fixture (cached after the first time)`);
  const gen = await run(
    "cargo",
    ["run", "--release", "--quiet", "-p", "fixture", "--", "--scale", scale, "--out", FIXTURES],
    "fixture",
  );
  const fixture = gen.stdout.at(-1);
  return gen.code === 0 && fixture ? fixture : null;
}

/** Writes pristine mirrors unless they're already seeded at `scale`; false when that fails. */
async function seedMirrors(scale: Scale, fixture: string): Promise<boolean> {
  if (readJson<{ scale: Scale }>(SEEDED)?.scale === scale) return true;
  log("dev-ctl", "seeding pristine mirrors");
  remove(MIRRORS);
  const seed = await run(
    BINARIES.fake,
    ["pristine-mirrors", "--fixture", fixture, "--db", FAKE_DB, "--dir", MIRRORS],
    "fake",
  );
  if (seed.code !== 0) return false;
  writeJson(SEEDED, { scale });
  return true;
}

/** How each process is launched: command, arguments and extra environment. */
function commands(fixture: string): Record<Proc, () => [string, string[], NodeJS.ProcessEnv]> {
  return {
    fake: () => [
      BINARIES.fake,
      [
        "serve",
        "--fixture",
        fixture,
        "--db",
        FAKE_DB,
        "--port",
        String(PORTS.fake),
        "--control-port",
        String(PORTS.control),
        "--client-id",
        CLIENT.id,
        "--client-secret",
        CLIENT.secret,
        // Straight to the server: GitHub's deliveries never pass through the app's origin.
        "--webhook-url",
        `${URLS.server}/webhook`,
        "--webhook-secret",
        DEV_WEBHOOK_SECRET,
      ],
      {},
    ],
    server: () => [
      BINARIES.server,
      [],
      {
        PORT: String(PORTS.server),
        BEGHU_BUILD_ID: "dev",
        BEGHU_PUBLIC_URL: URLS.app,
        // control.db, backups/ and mirrors/ live here; `reset --all` deletes the first two.
        BEGHU_DATA_DIR: DATA,
        BEGHU_TOKEN_KEY: DEV_TOKEN_KEY,
        GITHUB_API_URL: URLS.fake,
        GITHUB_WEB_URL: URLS.fake,
        GITHUB_CLIENT_ID: CLIENT.id,
        GITHUB_CLIENT_SECRET: CLIENT.secret,
        GITHUB_WEBHOOK_SECRET: DEV_WEBHOOK_SECRET,
        RUST_LOG: process.env.RUST_LOG ?? "info",
      },
    ],
    vite: () => [
      process.execPath,
      [join(ROOT, "web", "node_modules", "vite", "bin", "vite.js"), "--port", String(PORTS.app)],
      { BEGHU_SERVER: URLS.server },
    ],
  };
}

type Stack = ReturnType<typeof processes>;

/** A process that exits within this long of starting failed fast; one up this long is healthy. */
const STABLE_MS = 10_000;
/** Fast failures in a row before a process is given up on. */
const MAX_FAST_FAILURES = 5;
/** The wait before the first restart, doubled for each fast failure in a row. */
const RESTART_MS = 500;

interface Events {
  /** A process was spawned. */
  started: (name: Proc, pid: number) => void;
  /** A process kept failing fast and won't be restarted until a rebuild restarts it. */
  gaveUp: (name: Proc, why: string) => void;
  /** A process has stayed up for a while after failing. */
  recovered: (name: Proc) => void;
}

/**
 * The three child processes: starting, stopping and restarting them, with their output logged.
 * One that exits (or can't be spawned) when nothing asked it to is started again with backoff.
 */
function processes(fixture: string, events: Events) {
  const command = commands(fixture);
  const children = new Map<Proc, ChildProcess>();
  const restarting = new Set<Proc>();
  /** Fast failures in a row, per process. */
  const failures = new Map<Proc, number>();
  const pending = new Map<Proc, NodeJS.Timeout>();
  let stopping = false;

  const start = (name: Proc) => {
    const [cmd, args, env] = command[name]();
    const cwd = name === "vite" ? join(ROOT, "web") : ROOT;
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = Date.now();
    children.set(name, child);
    capture(child, name);
    if (child.pid !== undefined) events.started(name, child.pid);
    const stable = setTimeout(() => {
      if (failures.delete(name)) events.recovered(name);
    }, STABLE_MS);
    let ended = false;
    const end = (why: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(stable);
      if (children.get(name) === child) children.delete(name);
      if (stopping || restarting.has(name)) return;
      log("dev-ctl", `${name} ${why}`);
      const fast = Date.now() - startedAt < STABLE_MS;
      const n = fast ? (failures.get(name) ?? 0) + 1 : 1;
      failures.set(name, n);
      if (n > MAX_FAST_FAILURES) {
        events.gaveUp(name, `${name} failed ${n} times in a row; not restarting it until a rebuild does (see its lines in the log)`);
        return;
      }
      const wait = RESTART_MS * 2 ** (n - 1);
      log("dev-ctl", `restarting ${name} in ${wait} ms`);
      pending.set(
        name,
        setTimeout(() => {
          pending.delete(name);
          if (!stopping && !children.has(name)) start(name);
        }, wait),
      );
    };
    // A spawn failure (a missing binary, say) is an `error` with no `exit`. So is a signal that
    // couldn't be sent, to a child still running: that one isn't gone, and its `exit` comes later.
    child.on("error", (e) => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) end(`couldn't run: ${e.message}`);
      else log("dev-ctl", `${name}: ${e.message}`);
    });
    child.on("exit", (code, signal) => end(`exited (${signal ?? `code ${code}`})`));
  };

  const stop = (name: Proc): Promise<void> =>
    new Promise((done) => {
      const child = children.get(name);
      if (!child || child.exitCode !== null) return done();
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.on("exit", () => {
        clearTimeout(kill);
        done();
      });
      child.kill("SIGTERM");
    });

  return {
    running: (name: Proc) => children.has(name),
    startAll: () => {
      for (const name of ["fake", "server", "vite"] as Proc[]) start(name);
    },
    stopAll: async () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      await Promise.all((["vite", "server", "fake"] as Proc[]).map(stop));
    },
    /** False when a stop is already under way. */
    beginStopping: () => {
      if (stopping) return false;
      stopping = true;
      return true;
    },
    restart: async (name: Proc) => {
      clearTimeout(pending.get(name));
      pending.delete(name);
      restarting.add(name);
      await stop(name);
      restarting.delete(name);
      log("dev-ctl", `restarting ${name}`);
      start(name);
    },
  };
}

type Tokens = FakeState["tokens"] | undefined;

/**
 * Rebuilds the Rust binaries and restarts whichever changed. Resolves to the token lifetimes
 * the fake runs with now: read again after a restart, since its flags may have changed.
 */
async function rebuildAndRestart(stack: Stack, startupTokens: Tokens): Promise<Tokens> {
  const before = mtimes();
  log("dev-ctl", "sources changed; rebuilding");
  if ((await build()).code !== 0) {
    log("dev-ctl", "the build failed; the running processes are unchanged");
    return startupTokens;
  }
  const after = mtimes();
  if (after.fake !== before.fake) {
    // The fake keeps fault rules and token lifetimes in memory, so a restart drops them.
    const lost = runtimeSettings(await fakeState(URLS.control), startupTokens);
    await stack.restart("fake");
    startupTokens = (await fakeStateOnceUp(stack))?.tokens;
    if (lost === null) {
      log("dev-ctl", "Fake GitHub restarted: any fault rules or token lifetimes set at runtime are gone");
    } else if (lost.length > 0) {
      log("dev-ctl", `Fake GitHub restarted and lost its runtime settings: ${lost.join(", ")}. Set them again with ./dev-ctl fake`);
    }
  }
  if (after.server !== before.server) await stack.restart("server");
  return startupTokens;
}

/** The fake's state once a restarted fake answers; null if it exits or takes over 30 s. */
async function fakeStateOnceUp(stack: Stack): Promise<FakeState | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && stack.running("fake")) {
    const s = await fakeState(URLS.control);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** What the fake holds only in memory that differs from how it started; null when unknown. */
function runtimeSettings(now: FakeState | null, startupTokens: Tokens): string[] | null {
  if (!now || !startupTokens) return null;
  const lost: string[] = [];
  if (now.faults.down) lost.push("down");
  if (now.faults.latency.length) lost.push(`${now.faults.latency.length} latency rule(s)`);
  if (now.faults.fail.length) lost.push(`${now.faults.fail.length} fail rule(s)`);
  const w = now.webhooks.faults;
  if (w.drop || w.duplicate || w.reorder || w.delay_ms) lost.push("webhook faults");
  if (now.clock?.offset) lost.push(`the clock offset (${now.clock.offset}s)`);
  const { access_ttl, refresh_ttl } = now.tokens;
  if (access_ttl !== startupTokens.access_ttl || refresh_ttl !== startupTokens.refresh_ttl) {
    lost.push(`token lifetimes (access ${access_ttl}s, refresh ${refresh_ttl}s)`);
  }
  return lost;
}

function mtimes(): Record<"fake" | "server", number> {
  const m = (p: string) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return { fake: m(BINARIES.fake), server: m(BINARIES.server) };
}

/** Calls `rebuild` after Rust sources settle, never two at once; changes during a build queue one more. */
function watchSources(rebuild: () => Promise<void>): void {
  let timer: NodeJS.Timeout | undefined;
  let busy = false;
  let again = false;
  const go = async () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    do {
      again = false;
      await rebuild();
    } while (again);
    busy = false;
  };
  const changed = (file: string | null) => {
    if (file && !/\.(rs|sql|toml)$|Cargo\.lock$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(go, 300);
  };
  watch(join(ROOT, "crates"), { recursive: true }, (_, f) => changed(f));
  for (const f of ["Cargo.toml", "Cargo.lock"]) watch(join(ROOT, f), () => changed(f));
}

/** True once every process answers, or the name of the first that didn't within `ms`. */
async function waitUntilUp(ms: number, running: (name: Proc) => boolean): Promise<true | Proc> {
  const checks: [Proc, string][] = [
    ["fake", `${URLS.control}/state`],
    ["server", `${URLS.server}/healthz`],
    ["vite", `${URLS.app}/`],
  ];
  const deadline = Date.now() + ms;
  for (const [name, url] of checks) {
    while (!(await up(url))) {
      if (Date.now() > deadline || !running(name)) return name;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return true;
}

export async function up(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer()
      .once("error", () => done(false))
      .once("listening", () => probe.close(() => done(true)));
    probe.listen(port);
  });
}
