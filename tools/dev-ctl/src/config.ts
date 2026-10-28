// Paths, ports and the processes of the dev stack.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const DEV = join(ROOT, ".dev");
export const LOG = join(DEV, "dev.log");
export const PID = join(DEV, "dev-ctl.pid");
export const STATE = join(DEV, "dev-ctl.json");
export const DATA = join(DEV, "data");
export const MIRRORS = join(DATA, "mirrors");
export const FAKE_DB = join(DATA, "fake", "truth.db");
/** What `start` seeded the data with (`Seeded`). Gone after a plain `reset`, so `start` seeds again. */
export const SEEDED = join(DATA, "seeded.json");
export const FIXTURES = join(ROOT, "perf", "data");
/** Web builds `deploy` made, one directory per build id. */
export const WEB_BUILDS = join(DEV, "web");
/**
 * What `deploy` put the server on (`Deployed`); none while it runs as `dev` with no web build of
 * its own (Vite serves the app). `start` removes it.
 */
export const DEPLOYED = join(DEV, "deployed.json");
/** The volume's asset store, and each build's record of its assets (crates/server/src/assets.rs). */
export const ASSETS = join(DATA, "assets");
export const BUILDS = join(DATA, "builds");
export const TARGET = join(ROOT, "target", "debug");

const port = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`${name} must be a port number, got ${v}`);
  return n;
};

export const PORTS = {
  app: port("DEV_APP_PORT", 5173),
  server: port("DEV_SERVER_PORT", 3000),
  fake: port("DEV_FAKE_PORT", 3100),
  control: port("DEV_FAKE_CONTROL_PORT", 3101),
};

export const URLS = {
  app: `http://localhost:${PORTS.app}`,
  server: `http://localhost:${PORTS.server}`,
  fake: `http://127.0.0.1:${PORTS.fake}`,
  control: `http://127.0.0.1:${PORTS.control}`,
};

/** The OAuth client the dev server uses with the fake. */
export const CLIENT = { id: "Iv1.fakegithub", secret: "fake-github-secret" };

/** The App's webhook secret in dev: the fake signs deliveries with it, the server checks them. */
export const DEV_WEBHOOK_SECRET = "fake-github-webhook-secret";

/**
 * The dev App (crates/fake-github/src/app.rs): its id, its slug, and its private key, which signs
 * the JWTs the server trades with the fake for installation tokens. Fake GitHub checks them
 * against the same key. Dev data only: never use it elsewhere.
 */
export const DEV_APP = {
  id: "1000001",
  slug: "beghu-dev",
  keyFile: join(ROOT, "crates", "fake-github", "src", "dev-app-key.pem"),
};

/** The dev server's BEGHU_TOKEN_KEY (base64, 38 bytes). Dev data only: never use it elsewhere. */
export const DEV_TOKEN_KEY = "ZGV2LW9ubHkgYmVnaHUgdG9rZW4ga2V5LCBub3QgYSBzZWNyZXQ=";

export const SCALES = ["1k", "20k", "50k"] as const;
export type Scale = (typeof SCALES)[number];
export const DEFAULT_SCALE: Scale = "50k";

/**
 * `seeded.json`: the scale and the fixture file the pristine mirrors were copied from, or, after
 * `reset --fresh`, `fresh` (mirrors deleted, so the accounts import their own).
 */
export type Seeded = { scale: Scale; fixture?: string; fresh?: boolean };

/** The build the server runs after `deploy`, and the web build it serves (BEGHU_WEB_DIR). */
export type Deployed = { build: string; web: string };

export const PROCS = ["dev-ctl", "cargo", "fixture", "fake", "server", "vite"] as const;

/** What a running stack records about itself for `status`, `reset` and friends. */
export interface State {
  pid: number;
  mode: "fixture";
  scale: Scale;
  fixture: string | null;
  phase: "starting" | "ready" | "failed";
  /** Where the stack listens: the ports it was started with. */
  urls: typeof URLS;
  error?: string;
  /** The process given up on, when that's why the phase is `failed`. */
  failed?: string;
  /** The pid of each process as last started. */
  children?: Partial<Record<"fake" | "server" | "vite", number>>;
  startedAt: string;
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Writes `value` whole or not at all: a reader never sees half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running stack's URLs, or the configured ones when nothing runs. */
export function urls(): typeof URLS {
  return running()?.state?.urls ?? URLS;
}

/** The supervisor's own script: its command line names it, then `__supervise`. */
export const SUPERVISOR = join(ROOT, "tools", "dev-ctl", "src", "main.ts");

/**
 * Whether `pid` is this checkout's supervisor: alive, and running `main.ts __supervise` from
 * this ROOT, not a process that took over a stale pid. Without /proc (not Linux), alive is all
 * there is to go on.
 */
function isSupervisor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  if (!existsSync("/proc/self/cmdline")) return true;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const at = args.indexOf(SUPERVISOR);
    return at >= 0 && args[at + 1] === "__supervise";
  } catch {
    return false;
  }
}

/** The running stack's supervisor pid and state, or null when nothing runs. */
export function running(): { pid: number; state: State | null } | null {
  if (!existsSync(PID)) return null;
  const pid = Number(readFileSync(PID, "utf8").trim());
  if (!isSupervisor(pid)) {
    remove(PID);
    remove(STATE);
    return null;
  }
  return { pid, state: readJson<State>(STATE) };
}

/** What Fake GitHub's control port reports at `/state`. */
export interface FakeState {
  fixture: string;
  accounts: { login: string; id: number; name: string }[];
  signed_in: string[];
  tokens: { access_ttl: number; refresh_ttl: number };
  faults: {
    down: boolean;
    /** `remaining`: a rule for only the next calls. */
    latency: { endpoint: string; ms: number; remaining?: number }[];
    /** `status` is null for a `reset` (no answer at all). */
    fail: {
      endpoint: string;
      remaining: number;
      status: number | null;
      retry_after: number | null;
      limit: "primary" | "secondary" | "graphql" | null;
      reset?: boolean;
    }[];
    rewrite: { endpoint: string; remaining: number; body: string }[];
  };
  /** Refresh tokens honoured, and refresh tokens that came back already spent. */
  refreshes: { ok: number; reused: number };
  /** Where webhooks go, and the faults on the next deliveries. */
  webhooks: { url: string | null; faults: WebhookFaults };
  /** Seconds the fake's clock runs ahead of the real one. */
  clock: { offset: number };
  /** The rate-limit fault: every token reads as at most `cap` calls left (`null`: none). */
  quota: { cap: number | null };
  /** Where the install page sends the browser afterwards. */
  setup_url: string | null;
}

export interface WebhookFaults {
  drop: number;
  /** With it, `drop` counts only deliveries of this `event.action`. */
  drop_only: string | null;
  duplicate: number;
  reorder: number;
  delay_ms: number;
}

/**
 * The fake's state from its control port at `control`, or null when it doesn't answer within
 * `ms`. A fake that isn't running refuses the connection at once; only a slow answer waits.
 */
export async function fakeState(control: string, ms = 5000): Promise<FakeState | null> {
  try {
    const res = await fetch(`${control}/state`, { signal: AbortSignal.timeout(ms) });
    return res.ok ? ((await res.json()) as FakeState) : null;
  } catch {
    return null;
  }
}
