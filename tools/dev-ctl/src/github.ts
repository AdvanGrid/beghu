// Real-GitHub dev mode: each developer's own dev App under AdvanGrid, its credentials under
// .dev/github/ (gitignored), and the checks `github setup` makes before `start --github` uses them.
import { createSign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEV, ROOT } from "./config.ts";

/** Where `github setup` keeps the dev App's credentials. */
export const GITHUB_DIR = join(DEV, "github");
export const APP_FILE = join(GITHUB_DIR, "app.json");
export const KEY_FILE = join(GITHUB_DIR, "app.pem");
/** Where `start --github` keeps its own data: never mixed with the fixture mode's. */
export const GITHUB_DATA = join(DEV, "data-github");
/** The only repo dev mode writes to (BEGHU_DEV_WRITABLE_REPOS). */
export const SANDBOX = "AdvanGrid/beghu-sandbox";
/** Where create-app.mjs leaves a new App's credentials: `<slug>.json` and `<slug>.pem`. */
const CREATED = join(DEV, "github-app");

/** A dev App, as `github setup` keeps it. */
export interface DevApp {
  id: string;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  /** The smee.io channel the App's webhook URL points at, which `start --github` listens to. */
  smee_url: string;
  /** The installation that covers the sandbox, found when the setup was checked. */
  installation_id: number;
  /** Repos `./dev-ctl contract` reads by default: the App's busy repos. */
  repos: string[];
  /** The API it was checked against: GitHub's, unless a Fake GitHub stood in. */
  api: string;
}

export function readDevApp(): DevApp | null {
  try {
    return JSON.parse(readFileSync(APP_FILE, "utf8")) as DevApp;
  } catch {
    return null;
  }
}

/** The App's JWT, as GitHub wants one: RS256, backdated a minute, good for 9. */
export function appJwt(appId: string, pem: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem, "base64url")}`;
}

async function call(api: string, method: string, path: string, jwt: string, body?: unknown) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** The credentials given on the command line, or create-app.mjs's for the App it made. */
export interface SetupArgs {
  appJson?: string;
  key?: string;
  appId?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  smee?: string;
  repos?: string;
  sandbox: string;
  api: string;
}

/** What `github setup` found: the App's credentials checked by minting a token, or why not. */
export interface Checked {
  app: DevApp;
  pem: string;
  /** The App's slug and owner as GitHub reports them. */
  owner: string;
  /** Events the manifest asks for that the App isn't subscribed to. */
  missingEvents: string[];
  /** The App's webhook URL, when GitHub says it (`GET /app/hook/config`). */
  hookUrl: string | null;
}

class SetupError extends Error {}
export { SetupError };

function gather(a: SetupArgs): { app: Omit<DevApp, "installation_id" | "api">; pem: string } {
  let made: Record<string, unknown> = {};
  let keyPath = a.key;
  if (a.appJson) {
    made = JSON.parse(readFileSync(a.appJson, "utf8")) as Record<string, unknown>;
    keyPath ??= a.appJson.replace(/\.json$/, ".pem");
  } else if (!a.appId && existsSync(CREATED)) {
    // The one App create-app.mjs made, if there's exactly one.
    const found = readdirSync(CREATED).filter((f) => f.endsWith(".json"));
    if (found.length === 1) {
      made = JSON.parse(readFileSync(join(CREATED, found[0]!), "utf8")) as Record<string, unknown>;
      keyPath ??= join(CREATED, found[0]!.replace(/\.json$/, ".pem"));
    } else if (found.length > 1) {
      throw new SetupError(`${found.length} Apps in .dev/github-app/; pick one with --app-json`);
    }
  }
  const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
  const app = {
    id: a.appId ?? str(made.id) ?? "",
    slug: str(made.slug) ?? "",
    client_id: a.clientId ?? str(made.client_id) ?? "",
    client_secret: a.clientSecret ?? str(made.client_secret) ?? "",
    webhook_secret: a.webhookSecret ?? str(made.webhook_secret) ?? "",
    smee_url: a.smee ?? "",
    repos: (a.repos ?? a.sandbox).split(",").map((r) => r.trim()).filter(Boolean),
  };
  const missing = Object.entries({
    "--app-id": app.id,
    "--client-id": app.client_id,
    "--client-secret": app.client_secret,
    "--webhook-secret": app.webhook_secret,
    "--smee": app.smee_url,
    "--key": keyPath ?? "",
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new SetupError(
      `missing ${missing.join(", ")}: pass them, or --app-json with the credentials create-app.mjs wrote (.dev/github-app/<slug>.json and .pem)`,
    );
  }
  if (!/^\d+$/.test(app.id)) throw new SetupError(`--app-id is the App's numeric id, got ${app.id}`);
  if (!/^https:\/\/smee\.io\/\w+$/.test(app.smee_url) && !a.api.startsWith("http://")) {
    throw new SetupError(`--smee is the smee.io channel the App's webhook URL points at, got ${app.smee_url}`);
  }
  return { app, pem: readFileSync(keyPath!, "utf8") };
}

/**
 * Checks the credentials against GitHub (or the Fake GitHub at `api`): the JWT is accepted
 * (`GET /app`), the App is installed on the sandbox, and that installation mints a token. Throws a
 * SetupError naming what failed.
 */
export async function check(a: SetupArgs): Promise<Checked> {
  const { app, pem } = gather(a);
  let jwt: string;
  try {
    jwt = appJwt(app.id, pem);
  } catch (e) {
    throw new SetupError(`the key doesn't sign: ${(e as Error).message}`);
  }
  const me = await call(a.api, "GET", "/app", jwt);
  if (me.status !== 200 || !me.json) {
    throw new SetupError(`GitHub refused the App's JWT (GET /app answered ${me.status}): check --app-id and the key`);
  }
  const slug = String(me.json.slug ?? app.slug);
  const owner = String((me.json.owner as { login?: string } | undefined)?.login ?? "?");
  const events = (me.json.events as string[] | undefined) ?? [];
  const manifest = JSON.parse(readFileSync(join(ROOT, "github-app", "manifest.json"), "utf8")) as { default_events: string[] };
  const missingEvents = manifest.default_events.filter((e) => !events.includes(e));
  const [o, n] = a.sandbox.split("/");
  const inst = await call(a.api, "GET", `/repos/${o}/${n}/installation`, jwt);
  const installation = Number((inst.json as { id?: number } | null)?.id);
  if (inst.status !== 200 || !Number.isInteger(installation)) {
    throw new SetupError(`${slug} isn't installed on ${a.sandbox} (GET /repos/${o}/${n}/installation answered ${inst.status}); install it there`);
  }
  const minted = await call(a.api, "POST", `/app/installations/${installation}/access_tokens`, jwt, {
    repositories: [n],
    permissions: { metadata: "read" },
  });
  if (minted.status !== 201 || typeof minted.json?.token !== "string") {
    throw new SetupError(`minting an installation token for ${a.sandbox} answered ${minted.status}`);
  }
  const hook = await call(a.api, "GET", "/app/hook/config", jwt);
  const hookUrl = hook.status === 200 && typeof hook.json?.url === "string" ? hook.json.url : null;
  return {
    app: { ...app, slug, installation_id: installation, api: a.api },
    pem,
    owner,
    missingEvents,
    hookUrl,
  };
}

/** Keeps checked credentials under .dev/github/, readable only by their owner. */
export function save(c: Checked): void {
  mkdirSync(GITHUB_DIR, { recursive: true, mode: 0o700 });
  // An existing directory keeps its mode through mkdir: set it.
  chmodSync(GITHUB_DIR, 0o700);
  writeFileSync(APP_FILE, JSON.stringify(c.app, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(KEY_FILE, c.pem, { mode: 0o600 });
  chmodSync(APP_FILE, 0o600);
  chmodSync(KEY_FILE, 0o600);
}
