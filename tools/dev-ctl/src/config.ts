// Paths, ports and the processes of the dev stack.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** What `start` seeded the data with: `{scale}`. Gone after a plain `reset`, so `start` seeds again. */
export const SEEDED = join(DATA, "seeded.json");
export const FIXTURES = join(ROOT, "perf", "data");
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

/** The dev server's BEGHU_TOKEN_KEY (base64, 38 bytes). Dev data only: never use it elsewhere. */
export const DEV_TOKEN_KEY = "ZGV2LW9ubHkgYmVnaHUgdG9rZW4ga2V5LCBub3QgYSBzZWNyZXQ=";

export const SCALES = ["1k", "20k", "50k"] as const;
export type Scale = (typeof SCALES)[number];
export const DEFAULT_SCALE: Scale = "50k";

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
  startedAt: string;
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
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

/** The running stack's supervisor pid and state, or null when nothing runs. */
export function running(): { pid: number; state: State | null } | null {
  if (!existsSync(PID)) return null;
  const pid = Number(readFileSync(PID, "utf8").trim());
  if (!Number.isInteger(pid) || !alive(pid)) {
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
    latency: { endpoint: string; ms: number }[];
    fail: { endpoint: string; remaining: number; status: number; retry_after: number | null }[];
  };
  /** Refresh tokens honoured, and refresh tokens that came back already spent. */
  refreshes: { ok: number; reused: number };
}

/** The fake's state from its control port at `control`, or null when it doesn't answer. */
export async function fakeState(control: string): Promise<FakeState | null> {
  try {
    const res = await fetch(`${control}/state`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as FakeState) : null;
  } catch {
    return null;
  }
}
