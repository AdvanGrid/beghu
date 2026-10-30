// ./dev-ctl: runs the beghu dev stack (Fake GitHub, the server, Vite) in the background.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ASSETS,
  BUILDS,
  DATA,
  DEFAULT_SCALE,
  DEPLOYED,
  type Deployed,
  DEV,
  DEV_WEBHOOK_SECRET,
  FAKE_DB,
  LOG,
  MIRRORS,
  PID,
  PROCS,
  ROOT,
  SCALES,
  type FakeState,
  type Scale,
  SEEDED,
  type Seeded,
  STATE,
  SUPERVISOR,
  type State,
  URLS,
  WEB_BUILDS,
  alive,
  fakeState,
  urls,
  readJson,
  remove,
  running,
  writeJson,
} from "./config.ts";
import { SMEE, supervise, superviseGitHub, up } from "./supervisor.ts";
import { BadArgs, contract, github, readDevApp } from "./realgithub.ts";

const HELP = `./dev-ctl - run the beghu dev stack against Fake GitHub

Usage: ./dev-ctl <command> [args] [--json]

--json prints the result as JSON; logs and grep print log lines only and refuse it.

Commands:
  start [--scale 1k|20k|50k]  Build, then start Fake GitHub, the server and Vite in the
                              background, in fixture mode (default scale ${DEFAULT_SCALE}). Waits
                              until all three answer; exits 1 with the log tail if not.
                              The server and the fake rebuild and restart when their
                              sources change; a process that exits on its own is
                              restarted. No-op if already running.
  start --github              Against real GitHub instead, through your own dev App (see
                              github setup): the server (its data in .dev/data-github),
                              smee forwarding the App's webhooks, and Vite. No fake. It
                              reads the repos you can see and writes only to
                              AdvanGrid/beghu-sandbox; any other write is refused.
  github setup [--app-json FILE] [--key PEM] [--app-id ID] [--client-id ID]
               [--client-secret S] [--webhook-secret S] --smee URL [--repos R,…]
                              Copy your dev App's credentials into .dev/github/ (never
                              committed) and check them: the JWT works, the App is
                              installed on the sandbox, and it mints an installation
                              token. --app-json takes what github-app/create-app.mjs
                              wrote (.dev/github-app/<slug>.json, .pem beside it); the
                              flags override it. --smee is the channel the App's webhook
                              URL points at. --repos: what contract reads by default.
  contract read|write [--fake] [--report] [OPTIONS]
  contract record read|write [--fake] [OPTIONS]
                              The contract check (crates/contract): diff GitHub's answers
                              with Fake GitHub's recorded templates. read: the read set on
                              your dev App's repos and its webhook deliveries; write:
                              beghu's writes on the sandbox, each undone. record writes the
                              templates again from the answers. --fake runs against the
                              running stack's Fake GitHub instead. --report posts to the
                              "Contract drift" issue on the sandbox. OPTIONS pass through
                              (cargo run -p contract -- help). Exit 1 on drift.
  stop                        Stop everything.
  status                      Mode, scale, URLs, each process up or down (--json: and its
                              pid, and the dev webhook secret), the fake users signed in,
                              and the active fault rules.
                              Exit 1 if not running.
  logs [-n N] [-f] [PROC]     The last N lines (default 100) of the one log, optionally
                              only one process: ${PROCS.join(", ")}.
                              -f follows until Ctrl-C.
  grep PATTERN [PROC]         Search the whole log (regex, case-insensitive) with line
                              numbers; exit 1 if nothing matches.
  login USER                  Print the URL that signs the browser in as a fixture user
                              (skipping the fake's account picker).
  fake [state]                The fake's accounts, sign-ins, token lifetimes and faults.
  fake latency ENDPOINT MS [--count N]
                              Delay calls to ENDPOINT by MS (0 removes the rule); with
                              --count, only the next N.
  fake fail ENDPOINT STATUS|reset [--count N] [--retry-after S] [--limit KIND]
                              The next N calls (default 1) to ENDPOINT fail with STATUS
                              (409, 403/429 with --retry-after for a rate limit, 5xx),
                              or with reset get no answer (the connection drops).
                              --limit makes it one of GitHub's rate limits, in its own
                              shape: primary or secondary (403/429; a secondary limit
                              sends retry-after only if given), or graphql (status 200, a
                              RATE_LIMITED error).
  fake down | fake up         GitHub unreachable (new connections dropped), or back.
  fake edit REPO#N [--title T] [--body B] [--close [--reason not_planned]] [--reopen]
            [--label L,…] [--unlabel L,…] [--comment TEXT] [--as USER]
            [--add-sub-issue R#N] [--remove-sub-issue R#N] [--add-blocked-by R#N]
            [--remove-blocked-by R#N] [--relate R#N] [--unrelate R#N]
            [--prioritize-sub-issue R#N] [--link-issue R#N] [--unlink-issue R#N]
            [--review approve|request_changes|comment|dismiss] [--lock|--unlock] [--delete]
                              An outside edit on "GitHub" (as an agent with gh would make
                              it); its webhooks reach the server about a second later.
                              On a PR, --link-issue/--unlink-issue link an issue in the
                              Development sidebar (no webhook: the events feed shows it),
                              and --review reviews it (pull_request_review).
                              --delete deletes the issue instead (issues deleted). REPO
                              is a fixture repo name (web) or owner/name (acme/web). R#N may
                              be in an unsynced repo (partner-sdk#100), or #N in REPO.
                              --prioritize-sub-issue moves that sub-issue to the top, which
                              GitHub does without a webhook (sweeps find it).
                              --lock/--unlock lock or unlock the conversation (issues
                              locked/unlocked): below Write, no one can comment on it.
  fake upload image|video [--width W] [--height H] [--as USER]
                              Upload an attachment as GitHub's editor would (an image is a
                              PNG of that size, 640 × 360 by default; a video a short WebM)
                              and print the Markdown the editor writes, for a post.
  fake label REPO NAME [--rename NEW] [--color HEX] [--as USER]
                              Someone renames or recolours one of REPO's labels on
                              "GitHub", or creates it if REPO has none called NAME: its
                              label webhook (edited or created) follows.
  fake milestone REPO TITLE [--rename NEW] [--close|--reopen] [--as USER]
                              Someone renames, closes or reopens one of REPO's milestones
                              on "GitHub": its milestone webhook follows, and no issue's.
  fake transfer REPO#N TO [--as USER]
                              Someone transfers the issue to repo TO (same owner, installed
                              or not): it becomes a new issue there, with its links, and
                              its old number answers 301. Deliveries come as GitHub sends
                              them: issues opened in TO, the links again, issues
                              transferred in REPO.
  fake convert REPO#N [--as USER]
                              Someone converts the issue to a discussion: it stays,
                              closed and locked (issues locked, then closed).
  fake role USER REPO read|triage|write|maintain|admin|none
                              An admin gives USER that role on REPO on "GitHub" (none: no
                              access). GitHub sends beghu no webhook: beghu learns it at its
                              next re-read (every 15 min while USER has a tab open, or at
                              once when GitHub refuses one of USER's writes).
  fake archive REPO | fake unarchive REPO
                              An admin archives REPO, or unarchives it (repository
                              archived/unarchived).
  fake webhooks drop|duplicate|reorder N [--only EVENT.ACTION]
                              The next N deliveries are lost, sent twice under one GUID,
                              or (reorder, N >= 2) held and sent newest first. With
                              --only (drop alone), only the next N of that event and
                              action are lost (--only issues.transferred).
  fake webhooks delay MS      Every delivery waits MS longer (0 for none).
  fake quota N | fake quota off
                              Every token's rate limit reads as at most N calls left, as
                              if others had spent the rest (sweeps pause below a fifth), or
                              as GitHub counts it again.
  fake clear                  Remove every fault rule, webhook ones included.
  fake tokens [--access-ttl T] [--refresh-ttl T]
                              Lifetimes of new tokens: 30s, 5m, 8h, 184d.
  fake revoke USER            USER revokes beghu's authorization on "GitHub", which sends
                              github_app_authorization revoked: beghu asks USER to sign in
                              again, and re-imports once they do.
  fake uninstall USER         USER uninstalls the App from their own account (GitHub sends
                              installation deleted); signing in again offers to install it.
  fake suspend USER | fake unsuspend USER
                              USER suspends the App's installation on their own account,
                              or lifts it (GitHub sends installation suspend/unsuspend):
                              it still lists, but beghu reads nothing through it.
  deploy BUILD [--prune]      Deploy as production does, to see open tabs across it: build
                              the web app as build BUILD (letters, digits, . _ -; rebuilt
                              only when its sources changed) into .dev/web/BUILD, then
                              restart the server on it (BEGHU_BUILD_ID, BEGHU_WEB_DIR). It
                              then serves the built app at the server's URL, where only
                              reads work (writes come from the app's origin), while Vite's
                              tabs see the new build id. The volume keeps earlier builds'
                              assets; --prune deletes those this build doesn't have, and
                              the other builds' records, as their day being up would.
  deploy dev                  Back to build dev, the app served by Vite.
  reset [--all] [--fresh]     Restore pristine mirrors and the fake's state (sign-ins,
                              faults, its data), keeping the control DB (less its Resync
                              marks and hourly limits). Restarts the stack if it's running.
                              --all also wipes the control DB.
                              --fresh deletes the mirrors instead, so every account imports
                              its synced repos through the fake on its next use (with --all,
                              each picks its repos again after signing in).
  perf [--full] [--fresh] [--build-only] [GLOB...]
                              Whether this tree is slower than local main: about a minute
                              once both are built (minutes when main has moved).
                              Release builds of each (main in a worktree under the git
                              common dir's beghu-perf/, shared by every worktree and
                              cached by commit) run side by side at 50k, sampled in
                              turn. A timing more than 10% slower than main fails;
                              bytes and counts are held to perf-budgets.toml. --full
                              runs CI's three suites against this tree at their
                              absolute limits instead (minutes). GLOBs pick gates
                              ('server.*', '*.scan'). --fresh seeds the data again;
                              --build-only stops once both are built and seeded.
                              Writes .dev/perf/last.json and last.md; exit 1 if a gate
                              fails. One run per host at a time (a flock on
                              $TMPDIR/beghu-perf.lock). Independent of the dev stack.
                              To reclaim its disk (several GB): rm -rf .dev/perf
                              "$(git rev-parse --git-common-dir)/beghu-perf" &&
                              git worktree prune
  help                        This help.

ENDPOINT is * (everything) or a path with an optional method: "/user", "GET /user",
"/repos/*/*/issues/*/comments" (a * segment is any one segment), "/user/installations/*"
(everything under it). When several fail rules match a call, the first one added wins.

Fixture accounts: tomsj (admin everywhere), ilze-k (write/triage/read), octo-ext (read on
two repos), newcomer (no installation: signing in leads to installing the App on its own
newcomer/notes, then picking repos). Pristine mirrors exist for tomsj and ilze-k; octo-ext
picks its repos and imports them on its first sign-in.

URLs: app ${URLS.app}, server ${URLS.server}, fake ${URLS.fake} (control ${URLS.control}).
Ports: DEV_APP_PORT, DEV_SERVER_PORT, DEV_FAKE_PORT, DEV_FAKE_CONTROL_PORT.

Files: ${rel(LOG)} (the log, reset on each start), ${rel(DATA)} (control DB, mirrors, the
fake's truth).

Agents: avoid 'logs -f'; it never exits on its own.`;

function rel(p: string): string {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}

class Usage extends Error {}

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** Splits `--flag value` options (and bare `--json`) from positional arguments. */
function parse(args: string[], flags: string[], bools: string[] = []) {
  const opts: Record<string, string> = {};
  const set = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" || bools.includes(a)) set.add(a);
    else if (flags.includes(a)) {
      const v = args[++i];
      if (v === undefined) throw new Usage(`${a} needs a value`);
      opts[a] = v;
    } else if (a.startsWith("--")) throw new Usage(`unknown option ${a}`);
    else pos.push(a);
  }
  return { opts, set, pos, json: set.has("--json") };
}

const print = (json: boolean, data: unknown, text: string) =>
  console.log(json ? JSON.stringify(data, null, 2) : text);

// ---------------------------------------------------------------------------------------------
// start / stop

async function start(args: string[]): Promise<void> {
  const { opts, set, json } = parse(args, ["--scale"], ["--github"]);
  const gh = set.has("--github");
  if (gh && opts["--scale"]) throw new Usage("--github runs against GitHub: it has no scale");
  const scale = (opts["--scale"] ?? DEFAULT_SCALE) as Scale;
  if (!SCALES.includes(scale)) throw new Usage(`--scale is one of ${SCALES.join(", ")}`);
  const r = running();
  if (r) {
    print(json, { running: true, pid: r.pid }, `already running (pid ${r.pid}); see ./dev-ctl status`);
    return;
  }
  if (gh) {
    if (!readDevApp()) die("no dev App set up yet: run ./dev-ctl github setup (see ./dev-ctl help)");
    if (!existsSync(SMEE)) {
      if (!json) console.log("installing ./dev-ctl's dependencies (smee-client)");
      const npm = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(ROOT, "tools", "dev-ctl"), stdio: "inherit" });
      if (npm.status !== 0) die("npm ci in tools/dev-ctl failed");
    }
  }
  await startStack(gh ? "github" : scale, json);
}

/** Starts the stack and prints its status, with `extra` merged into the JSON. */
async function startStack(
  scale: Scale | "github",
  json: boolean,
  env: NodeJS.ProcessEnv = {},
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!existsSync(join(ROOT, "web", "node_modules", "vite"))) {
    if (!json) console.log("installing web dependencies");
    const npm = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(ROOT, "web"), stdio: "inherit" });
    if (npm.status !== 0) die("npm ci in web/ failed");
  }
  mkdirSync(DEV, { recursive: true });
  writeFileSync(LOG, "");
  const out = openSync(LOG, "a");
  // Its own process group, so `stop` ends it and everything it started together.
  const child = spawn(process.execPath, [SUPERVISOR, "__supervise", scale], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  closeSync(out);
  if (!json) {
    const what = scale === "github" ? "the first build" : `the first build and the ${scale} fixture`;
    console.log(`starting (log: ${rel(LOG)}); ${what} can take minutes`);
  }

  const timeout = Number(process.env.START_TIMEOUT ?? 1800) * 1000;
  const deadline = Date.now() + timeout;
  for (;;) {
    await sleep(500);
    const state = readJson<State>(STATE);
    if (state?.phase === "ready") break;
    if (state?.phase === "failed" || !alive(child.pid!)) {
      console.error(`start failed${state?.error ? `: ${state.error}` : ""}; last log lines:`);
      console.error(tail(30).join("\n"));
      process.exit(1);
    }
    if (Date.now() > deadline) die(`still starting after ${timeout / 1000}s; check ./dev-ctl logs`);
  }
  await status(json ? ["--json"] : [], extra);
}

async function stop(): Promise<boolean> {
  const r = running();
  if (!r) return false;
  try {
    process.kill(-r.pid, "SIGTERM");
  } catch {
    process.kill(r.pid, "SIGTERM");
  }
  for (let i = 0; i < 60 && alive(r.pid); i++) await sleep(250);
  if (alive(r.pid)) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {}
  }
  remove(PID);
  remove(STATE);
  return true;
}

// ---------------------------------------------------------------------------------------------
// status

function describeFaults(f: FakeState["faults"], w?: FakeState["webhooks"]["faults"], q?: FakeState["quota"]): string[] {
  const lines: string[] = [];
  if (f.down) lines.push("down: GitHub unreachable");
  if (q && q.cap !== null) lines.push(`quota: at most ${q.cap} calls left`);
  if (w?.drop) lines.push(`webhooks: drop the next ${w.drop}${w.drop_only ? ` ${w.drop_only}` : ""}`);
  if (w?.duplicate) lines.push(`webhooks: send the next ${w.duplicate} twice`);
  if (w?.reorder) lines.push(`webhooks: reorder the next ${w.reorder}`);
  if (w?.delay_ms) lines.push(`webhooks: +${w.delay_ms} ms`);
  for (const l of f.latency) lines.push(`latency ${l.endpoint}: ${l.ms} ms${l.remaining === undefined ? "" : `, next ${l.remaining}`}`);
  for (const r of f.fail) {
    const ra = r.retry_after === null ? "" : `, retry-after ${r.retry_after}s`;
    const limit = r.limit === null ? "" : ` (${r.limit} rate limit)`;
    const what = r.reset ? "no answer (reset)" : `${r.status}${limit}`;
    lines.push(`fail ${r.endpoint}: next ${r.remaining} with ${what}${ra}`);
  }
  for (const r of f.rewrite) lines.push(`rewrite ${r.endpoint}: next ${r.remaining} answer with body ${JSON.stringify(r.body)}`);
  return lines;
}

async function status(args: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const { json } = parse(args, []);
  const r = running();
  if (!r) {
    print(json, { running: false }, "not running");
    process.exit(1);
  }
  const s = r.state;
  const [app, server, fakeUp, fake] = await Promise.all([
    up(`${urls().app}/`),
    up(`${urls().server}/healthz`),
    up(`${urls().control}/state`),
    fakeState(urls().control),
  ]);
  const procs = { app, server, fake: fakeUp };
  const data = {
    ...extra,
    running: true,
    pid: r.pid,
    phase: s?.phase,
    error: s?.error ?? null,
    children: s?.children ?? null,
    mode: s?.mode,
    scale: s?.scale,
    // The server's build: `dev` (Vite serves the app) unless `deploy` put it on another.
    build: readJson<Deployed>(DEPLOYED)?.build ?? "dev",
    urls: urls(),
    // Dev data only: what the fake signs deliveries with, for a test that sends its own.
    webhook_secret: DEV_WEBHOOK_SECRET,
    up: procs,
    signed_in: fake?.signed_in ?? null,
    tokens: fake?.tokens ?? null,
    faults: fake?.faults ?? null,
    webhooks: fake?.webhooks ?? null,
  };
  const word = (b: boolean) => (b ? "up" : "DOWN");
  const faults = fake ? describeFaults(fake.faults, fake.webhooks.faults, fake.quota) : [];
  if (s?.mode === "github") {
    const dev = readDevApp();
    const text = [
      `running (pid ${r.pid}, ${s.phase}): github mode, as the dev App ${dev?.slug ?? "?"}`,
      ...(s.error ? [`  ${s.error}`] : []),
      `  app     ${urls().app}  ${word(app)}`,
      `  server  ${urls().server}  ${word(server)}`,
      `  smee    ${dev?.smee_url ?? "?"} -> ${urls().server}/webhook`,
      `writes go only to AdvanGrid/beghu-sandbox`,
    ].join("\n");
    return print(json, { ...data, up: { app, server }, dev_app: dev?.slug ?? null, smee: dev?.smee_url ?? null }, text);
  }
  const text = [
    `running (pid ${r.pid}, ${s?.phase ?? "unknown"}): ${s?.mode ?? "?"} mode, scale ${s?.scale ?? "?"}`,
    ...(s?.error ? [`  ${s.error}`] : []),
    `  app     ${urls().app}  ${word(app)}`,
    `  server  ${urls().server}  ${word(server)}  (build ${data.build}${data.build === "dev" ? "" : ", serving the app"})`,
    `  fake    ${urls().fake}  ${word(fakeUp)}  (control ${urls().control})`,
    `signed in to the fake: ${fake ? fake.signed_in.join(", ") || "nobody" : "unknown (fake down)"}`,
    `fault rules:${fake ? (faults.length ? "" : " none") : " unknown (fake down)"}`,
    ...faults.map((l) => `  ${l}`),
  ].join("\n");
  print(json, data, text);
}

// ---------------------------------------------------------------------------------------------
// logs / grep

function logLines(proc?: string): string[] {
  if (!existsSync(LOG)) die("no log yet; run ./dev-ctl start");
  const lines = readFileSync(LOG, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return proc ? lines.filter((l) => l.startsWith(`[${proc}] `)) : lines;
}

function tail(n: number): string[] {
  return existsSync(LOG) ? logLines().slice(-n) : [];
}

function checkProc(proc: string | undefined): void {
  if (proc && !(PROCS as readonly string[]).includes(proc)) throw new Usage(`unknown process ${proc}; one of ${PROCS.join(", ")}`);
}

async function logs(args: string[]): Promise<void> {
  const { opts, set, pos, json } = parse(args, ["-n"], ["-f", "--follow"]);
  if (json) throw new Usage("logs prints log lines, not JSON; drop --json");
  const proc = pos[0];
  checkProc(proc);
  const n = Number(opts["-n"] ?? 100);
  if (!Number.isInteger(n) || n < 0) throw new Usage("-n takes a number of lines");
  console.log(logLines(proc).slice(-n).join("\n"));
  if (!set.has("-f") && !set.has("--follow")) return;
  let count = logLines().length;
  watchFile(LOG, { interval: 300 }, () => {
    const all = logLines();
    if (all.length < count) count = 0; // restarted: the log was truncated
    const fresh = all.slice(count).filter((l) => !proc || l.startsWith(`[${proc}] `));
    count = all.length;
    if (fresh.length) console.log(fresh.join("\n"));
  });
  await new Promise(() => {});
}

function grep(args: string[]): void {
  const { pos, json } = parse(args, []);
  if (json) throw new Usage("grep prints log lines, not JSON; drop --json");
  const [pattern, proc] = pos;
  if (!pattern) throw new Usage("usage: ./dev-ctl grep PATTERN [PROC]");
  checkProc(proc);
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (e) {
    throw new Usage(`bad pattern: ${(e as Error).message}`);
  }
  const hits = logLines()
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => (!proc || l.startsWith(`[${proc}] `)) && re.test(l));
  for (const [i, l] of hits) console.log(`${i}:${l}`);
  if (!hits.length) process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// login / fake

/**
 * How long a command that needs the fake waits for it to answer. Far longer than `status` waits:
 * on a machine stalled on disk the whole fake process has been seen to pause for 6 s, and a
 * command that then gave up failed a test's cleanup with the fake running fine.
 */
const FAKE_ANSWERS_WITHIN_MS = 30_000;

async function needFake(): Promise<FakeState> {
  const s = await fakeState(urls().control, FAKE_ANSWERS_WITHIN_MS);
  if (!s) die("Fake GitHub isn't answering; run ./dev-ctl start (or check ./dev-ctl status)");
  return s;
}

async function login(args: string[]): Promise<void> {
  const { pos, json } = parse(args, []);
  const user = pos[0];
  if (!user) throw new Usage("usage: ./dev-ctl login USER");
  const s = await needFake();
  if (!s.accounts.some((a) => a.login === user)) {
    die(`${user} isn't a fixture account; one of ${s.accounts.map((a) => a.login).join(", ")}`);
  }
  const url = `${urls().app}/auth/login?login=${encodeURIComponent(user)}`;
  print(json, { user, url }, `open ${url}\n(signs in as ${user} through Fake GitHub, without its account picker)`);
}

async function control(method: string, path: string, body?: unknown): Promise<unknown> {
  await needFake();
  const res = await fetch(`${urls().control}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    die(`fake: ${err?.error ?? res.statusText}`);
  }
  return res.json();
}

/** `./dev-ctl fake edit REPO#N …`: the control port's `POST /edit` body. */
function editBody(target: string | undefined, opts: Record<string, string>, set: Set<string>): Record<string, unknown> {
  const m = target === undefined ? null : /^([\w.\/-]+)#(\d+)$/.exec(target);
  if (!m) throw new Usage("usage: ./dev-ctl fake edit REPO#N [--title T] [--body B] [--close] [--reopen] [--label L,…] [--unlabel L,…] [--comment TEXT] [--as USER] [--add-sub-issue R#N] [--remove-sub-issue R#N] [--add-blocked-by R#N] [--remove-blocked-by R#N] [--relate R#N] [--unrelate R#N] [--prioritize-sub-issue R#N] [--link-issue R#N] [--unlink-issue R#N] [--review KIND] [--lock|--unlock] [--delete]");
  if (set.has("--close") && set.has("--reopen")) throw new Usage("--close and --reopen don't go together");
  if (set.has("--lock") && set.has("--unlock")) throw new Usage("--lock and --unlock don't go together");
  const list = (v: string | undefined) => (v === undefined ? [] : v.split(",").map((l) => l.trim()).filter(Boolean));
  const body: Record<string, unknown> = { repo: m[1], number: Number(m[2]) };
  if (opts["--as"]) body.as = opts["--as"];
  if (set.has("--delete")) {
    const others = [...Object.keys(opts), ...set].filter((o) => !["--as", "--delete", "--json"].includes(o));
    if (others.length > 0) throw new Usage("--delete goes alone (with --as)");
    body.delete = true;
    return body;
  }
  if (opts["--title"] !== undefined) body.title = opts["--title"];
  if (opts["--body"] !== undefined) body.body = opts["--body"];
  if (set.has("--close")) body.state = "closed";
  if (set.has("--reopen")) body.state = "open";
  if (opts["--reason"]) {
    if (!set.has("--close")) throw new Usage("--reason goes with --close");
    body.state_reason = opts["--reason"];
  }
  if (opts["--label"]) body.add_labels = list(opts["--label"]);
  if (opts["--unlabel"]) body.remove_labels = list(opts["--unlabel"]);
  if (opts["--comment"] !== undefined) body.comment = opts["--comment"];
  if (set.has("--lock")) body.locked = true;
  if (set.has("--unlock")) body.locked = false;
  const links: [string, string][] = [
    ["--add-sub-issue", "add_sub_issue"],
    ["--remove-sub-issue", "remove_sub_issue"],
    ["--add-blocked-by", "add_blocked_by"],
    ["--remove-blocked-by", "remove_blocked_by"],
    ["--relate", "add_relates_to"],
    ["--unrelate", "remove_relates_to"],
    ["--prioritize-sub-issue", "prioritize_sub_issue"],
    ["--link-issue", "add_linked_issue"],
    ["--unlink-issue", "remove_linked_issue"],
    ["--review", "review"],
  ];
  for (const [flag, field] of links) if (opts[flag]) body[field] = opts[flag];
  if (Object.keys(body).length === 2) throw new Usage("fake edit needs something to change; see ./dev-ctl help");
  return body;
}

function seconds(v: string, flag: string): number {
  const m = /^(\d+)([smhd]?)$/.exec(v);
  if (!m || Number(m[1]) === 0) throw new Usage(`${flag} takes a lifetime like 30s, 5m, 8h or 184d`);
  return Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
}

async function fake(args: string[]): Promise<void> {
  const [sub = "state", ...rest] = args;
  const { opts, set, pos, json } = parse(
    rest,
    [
      "--count",
      "--retry-after",
      "--limit",
      "--access-ttl",
      "--refresh-ttl",
      "--title",
      "--body",
      "--reason",
      "--label",
      "--unlabel",
      "--comment",
      "--as",
      "--add-sub-issue",
      "--remove-sub-issue",
      "--add-blocked-by",
      "--remove-blocked-by",
      "--relate",
      "--unrelate",
      "--rename",
      "--color",
      "--prioritize-sub-issue",
      "--width",
      "--height",
      "--link-issue",
      "--unlink-issue",
      "--review",
      "--only",
    ],
    ["--close", "--reopen", "--delete", "--lock", "--unlock"],
  );
  const done = (text: string) => print(json, { ok: true }, text);
  switch (sub) {
    case "state": {
      const s = await needFake();
      const faults = describeFaults(s.faults, s.webhooks.faults, s.quota);
      print(
        json,
        s,
        [
          `fixture: ${rel(s.fixture)}`,
          `accounts: ${s.accounts.map((a) => a.login).join(", ")}`,
          `signed in: ${s.signed_in.join(", ") || "nobody"}`,
          `token lifetimes: access ${s.tokens.access_ttl}s, refresh ${s.tokens.refresh_ttl}s`,
          `webhooks to: ${s.webhooks.url ?? "nowhere"}`,
          `fault rules:${faults.length ? "" : " none"}`,
          ...faults.map((l) => `  ${l}`),
        ].join("\n"),
      );
      return;
    }
    case "latency": {
      const [endpoint, ms] = pos;
      if (!endpoint || ms === undefined || !/^\d+$/.test(ms)) throw new Usage("usage: ./dev-ctl fake latency ENDPOINT MS [--count N]");
      const count = opts["--count"] === undefined ? undefined : Number(opts["--count"]);
      if (count !== undefined && !(Number.isInteger(count) && count >= 1)) throw new Usage("--count takes a number of calls, at least 1");
      await control("POST", "/faults/latency", { endpoint, ms: Number(ms), count });
      return done(Number(ms) ? `${endpoint}: +${ms} ms` : `${endpoint}: latency removed`);
    }
    case "fail": {
      const [endpoint, status] = pos;
      if (!endpoint || !status || !/^(\d{3}|reset)$/.test(status)) {
        throw new Usage("usage: ./dev-ctl fake fail ENDPOINT STATUS|reset [--count N] [--retry-after S] [--limit KIND]");
      }
      const count = Number(opts["--count"] ?? 1);
      const retryAfter = opts["--retry-after"] === undefined ? null : Number(opts["--retry-after"]);
      if (!Number.isInteger(count) || count < 1) throw new Usage("--count takes a number of calls, at least 1");
      if (retryAfter !== null && !(Number.isInteger(retryAfter) && retryAfter >= 0)) throw new Usage("--retry-after takes seconds");
      const limit = opts["--limit"] ?? null;
      if (limit !== null && !["primary", "secondary", "graphql"].includes(limit)) {
        throw new Usage("--limit takes primary, secondary or graphql");
      }
      const reset = status === "reset";
      await control("POST", "/faults/fail", {
        endpoint,
        status: reset ? null : Number(status),
        reset,
        count,
        retry_after: retryAfter,
        limit,
      });
      return done(`${endpoint}: the next ${count} call(s) ${reset ? "get no answer" : `fail with ${status}`}`);
    }
    case "down":
    case "up":
      await control("POST", "/faults/down", { down: sub === "down" });
      return done(sub === "down" ? "GitHub is down" : "GitHub is back up");
    case "clear":
      await control("DELETE", "/faults");
      return done("fault rules cleared");
    case "edit": {
      const out = (await control("POST", "/edit", editBody(pos[0], opts, set))) as {
        issue: { id: number; title: string; updated_at: string };
        deliveries: number;
      };
      return print(
        json,
        out,
        `${pos[0]} edited (id ${out.issue.id}): ${out.deliveries} webhook(s) on the way`,
      );
    }
    case "upload": {
      const [kind] = pos;
      if (kind !== "image" && kind !== "video") {
        throw new Usage("usage: ./dev-ctl fake upload image|video [--width W] [--height H] [--as USER]");
      }
      const size = (flag: string) => (opts[flag] === undefined ? undefined : Number(opts[flag]));
      const out = (await control("POST", "/attachments", {
        kind,
        width: size("--width"),
        height: size("--height"),
        as: opts["--as"],
      })) as { uuid: string; url: string; markdown: string };
      return print(json, out, `uploaded: put this in a post (fake edit … --comment):\n${out.markdown}`);
    }
    case "label": {
      const [repo, name] = pos;
      const color = opts["--color"];
      if (!repo || !name || (opts["--rename"] === undefined && color === undefined)) {
        throw new Usage("usage: ./dev-ctl fake label REPO NAME [--rename NEW] [--color HEX] [--as USER]");
      }
      if (color !== undefined && !/^[0-9a-f]{6}$/i.test(color)) throw new Usage("--color takes 6 hex digits, without #");
      await control("POST", "/label", { repo, name, rename: opts["--rename"], color, as: opts["--as"] });
      return done(`${repo}'s label ${name} edited: its webhook is on the way`);
    }
    case "milestone": {
      const [repo, title] = pos;
      if (!repo || !title || (opts["--rename"] === undefined && !set.has("--close") && !set.has("--reopen"))) {
        throw new Usage("usage: ./dev-ctl fake milestone REPO TITLE [--rename NEW] [--close|--reopen] [--as USER]");
      }
      if (set.has("--close") && set.has("--reopen")) throw new Usage("--close and --reopen don't go together");
      const state = set.has("--close") ? "closed" : set.has("--reopen") ? "open" : undefined;
      await control("POST", "/milestone", { repo, title, rename: opts["--rename"], state, as: opts["--as"] });
      return done(`${repo}'s milestone ${title} edited: its webhook is on the way`);
    }
    case "transfer":
    case "convert": {
      const [target, to] = pos;
      const m = target === undefined ? null : /^([\w.\/-]+)#(\d+)$/.exec(target);
      if (!m || (sub === "transfer" && !to)) {
        throw new Usage(sub === "transfer" ? "usage: ./dev-ctl fake transfer REPO#N TO [--as USER]" : "usage: ./dev-ctl fake convert REPO#N [--as USER]");
      }
      const body = { repo: m[1], number: Number(m[2]), to, as: opts["--as"] };
      const out = (await control("POST", `/${sub}`, body)) as { issue: { id: number; number: number }; deliveries: number };
      const what = sub === "transfer" ? `transferred to ${to}#${out.issue.number} (id ${out.issue.id})` : "converted to a discussion";
      return print(json, out, `${target} ${what}: ${out.deliveries} webhook(s) on the way`);
    }
    case "role": {
      const [user, repo, role] = pos;
      const roles = ["read", "triage", "write", "maintain", "admin", "none"];
      if (!user || !repo || !role || !roles.includes(role)) {
        throw new Usage("usage: ./dev-ctl fake role USER REPO read|triage|write|maintain|admin|none");
      }
      await control("PUT", "/permissions", { login: user, repo, role: role === "none" ? null : role });
      return done(role === "none" ? `${user} has no access to ${repo}` : `${user} has ${role} on ${repo}`);
    }
    case "archive":
    case "unarchive": {
      const [repo] = pos;
      if (!repo) throw new Usage(`usage: ./dev-ctl fake ${sub} REPO`);
      await control("POST", "/archive", { repo, archived: sub === "archive", as: opts["--as"] });
      return done(`${repo} ${sub}d: its webhook is on the way`);
    }
    case "webhooks": {
      const [what, n] = pos;
      const num = Number(n);
      if (!what || n === undefined || !Number.isInteger(num) || num < 0) {
        throw new Usage("usage: ./dev-ctl fake webhooks drop|duplicate|reorder N, or fake webhooks delay MS");
      }
      if (what === "delay") {
        await control("POST", "/faults/webhooks", { delay_ms: num });
        return done(num ? `webhooks: +${num} ms` : "webhooks: no extra delay");
      }
      if (!["drop", "duplicate", "reorder"].includes(what)) throw new Usage(`unknown webhook fault ${what}`);
      if (what === "reorder" && num < 2) throw new Usage("reorder takes a batch of at least 2 deliveries");
      if (num < 1) throw new Usage(`${what} takes a number of deliveries, at least 1`);
      const only = opts["--only"];
      if (only !== undefined && (what !== "drop" || !/^[a-z_]+\.[a-z_]+$/.test(only))) {
        throw new Usage("--only goes with drop, as EVENT.ACTION (issues.transferred)");
      }
      await control("POST", "/faults/webhooks", only === undefined ? { [what]: num } : { drop: num, drop_only: only });
      return done(`webhooks: ${what} the next ${num}${only === undefined ? "" : ` ${only}`}`);
    }
    case "quota": {
      const [n] = pos;
      const num = Number(n);
      if (n !== "off" && (n === undefined || !Number.isInteger(num) || num < 0)) {
        throw new Usage("usage: ./dev-ctl fake quota N, or fake quota off");
      }
      await control("PUT", "/quota", { remaining: n === "off" ? null : num });
      return done(n === "off" ? "quota: as GitHub counts it" : `quota: at most ${num} calls left`);
    }
    case "tokens": {
      const body: Record<string, number> = {};
      if (opts["--access-ttl"]) body.access_ttl = seconds(opts["--access-ttl"], "--access-ttl");
      if (opts["--refresh-ttl"]) body.refresh_ttl = seconds(opts["--refresh-ttl"], "--refresh-ttl");
      if (!Object.keys(body).length) throw new Usage("usage: ./dev-ctl fake tokens [--access-ttl T] [--refresh-ttl T]");
      await control("PUT", "/tokens", body);
      return done("token lifetimes set for new tokens");
    }
    case "revoke": {
      const [user] = pos;
      if (!user) throw new Usage("usage: ./dev-ctl fake revoke USER");
      await control("POST", "/revoke", { login: user });
      return done(`${user} revoked beghu's authorization`);
    }
    case "uninstall": {
      const [user] = pos;
      if (!user) throw new Usage("usage: ./dev-ctl fake uninstall USER");
      await control("POST", "/uninstall", { login: user });
      return done(`${user} uninstalled the App`);
    }
    case "suspend":
    case "unsuspend": {
      const [user] = pos;
      if (!user) throw new Usage(`usage: ./dev-ctl fake ${sub} USER`);
      await control("POST", `/${sub}`, { login: user });
      return done(sub === "suspend" ? `${user} suspended the App's installation` : `${user} lifted the suspension`);
    }
    default:
      throw new Usage(`unknown fake command ${sub}; see ./dev-ctl help`);
  }
}

// ---------------------------------------------------------------------------------------------
// deploy

/** The web app's sources: a build made from other contents is rebuilt. */
function webSources(): string {
  const web = join(ROOT, "web");
  const files = ["index.html", "theme.js", "vite.config.ts", "package-lock.json", "markdown-parsers.ts"].map((f) => join(web, f));
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(web, "src"));
  const h = createHash("sha256");
  for (const f of files.sort()) {
    if (!existsSync(f)) continue;
    h.update(f).update("\0").update(readFileSync(f)).update("\0");
  }
  return h.digest("hex");
}

/** `.dev/web/<build>`, built from the sources as they are now; exits if the build fails. */
function webBuild(build: string, json: boolean): string {
  const out = join(WEB_BUILDS, build);
  const stamp = join(out, ".sources");
  const sources = webSources();
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === sources) return out;
  if (!json) console.log(`building the web app as ${build}`);
  const vite = spawnSync(
    process.execPath,
    [join(ROOT, "web", "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"],
    { cwd: join(ROOT, "web"), env: { ...process.env, BEGHU_BUILD_ID: build }, stdio: ["ignore", json ? "ignore" : "inherit", "inherit"] },
  );
  if (vite.status !== 0) die(`vite build failed for ${build}`);
  writeFileSync(stamp, sources);
  return out;
}

async function deploy(args: string[]): Promise<void> {
  const { set, pos, json } = parse(args, [], ["--prune"]);
  const [build] = pos;
  if (pos.length !== 1 || !/^[A-Za-z0-9._-]{1,64}$/.test(build!)) throw new Usage("usage: ./dev-ctl deploy BUILD [--prune] | deploy dev");
  if (build === "dev" && set.has("--prune")) throw new Usage("deploy dev has no assets to prune");
  const r = running();
  if (!r || r.state?.phase !== "ready") die("the stack isn't running (or isn't ready); ./dev-ctl start first");
  if (build === "dev") remove(DEPLOYED);
  else {
    const web = webBuild(build!, json);
    if (set.has("--prune") && existsSync(ASSETS)) {
      // As if every earlier build's day were up: only what this build has stays.
      const keep = new Set(readdirSync(join(web, "assets")));
      for (const f of readdirSync(ASSETS)) if (!keep.has(f)) remove(join(ASSETS, f));
      // And their records, as pruning drops them.
      if (existsSync(BUILDS)) for (const f of readdirSync(BUILDS)) if (f !== `${build}.json`) remove(join(BUILDS, f));
    }
    writeJson(DEPLOYED, { build: build!, web } satisfies Deployed);
  }
  process.kill(r.pid, "SIGUSR2");
  const deadline = Date.now() + 90_000;
  for (;;) {
    await sleep(250);
    try {
      const res = await fetch(`${urls().server}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok && ((await res.json()) as { build: string }).build === build) break;
    } catch {
      // Still restarting.
    }
    if (Date.now() > deadline) die(`the server isn't up as ${build} after 90 s; see ./dev-ctl logs server`);
  }
  const at = build === "dev" ? urls().app : urls().server;
  print(json, { build, url: at }, `deployed ${build}: the app is at ${at}`);
}

// ---------------------------------------------------------------------------------------------
// reset

/**
 * With pristine mirrors and a pristine fake, no account has changes to repair, and none has used
 * its hourly Resync on them: the control DB's marks and limits go (crates/server/src/reconcile).
 */
function forgetResyncs(): void {
  const path = join(DATA, "control.db");
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("UPDATE accounts SET needs_resync = 0, needs_resync_at = NULL, resync_asked_at = NULL");
  } catch {
    // A control DB from before reconciliation's columns: nothing to clear.
  } finally {
    db.close();
  }
}

async function reset(args: string[]): Promise<void> {
  const { set, pos, json } = parse(args, [], ["--all", "--fresh"]);
  if (pos.length) throw new Usage("usage: ./dev-ctl reset [--all] [--fresh]");
  const r = running();
  if (r?.state?.mode === "github") die("reset is for fixture mode: the stack runs against GitHub (./dev-ctl stop first)");
  const scale = r?.state?.scale ?? readJson<Seeded>(SEEDED)?.scale ?? DEFAULT_SCALE;
  if (r && !json) console.log("stopping the stack");
  await stop();

  const done: string[] = [];
  // The fake copies the fixture again on its next start: no sign-ins, no faults, pristine data.
  remove(join(FAKE_DB, ".."));
  done.push("fake state restored");
  remove(MIRRORS);
  if (set.has("--fresh")) {
    // Recorded as seeded, so start doesn't put pristine mirrors back: accounts re-import.
    writeJson(SEEDED, { scale, fresh: true } satisfies Seeded);
    done.push("mirrors deleted");
  } else {
    remove(SEEDED);
    done.push("mirrors will be pristine");
  }
  if (set.has("--all")) {
    // The server's names under BEGHU_DATA_DIR (crates/server/src/config.rs).
    for (const f of ["control.db", "control.db-wal", "control.db-shm", "backups"]) remove(join(DATA, f));
    done.push("control DB wiped");
  } else {
    forgetResyncs();
    done.push("control DB kept (its Resync marks and limits cleared)");
  }
  if (!json) console.log(done.join("; "));
  // Back on the ports it ran on.
  const was = r?.state?.urls;
  const port = (u: string) => new URL(u).port;
  const env = was
    ? {
        DEV_APP_PORT: port(was.app),
        DEV_SERVER_PORT: port(was.server),
        DEV_FAKE_PORT: port(was.fake),
        DEV_FAKE_CONTROL_PORT: port(was.control),
      }
    : {};
  if (r) await startStack(scale, json, env, { done });
  else if (json) print(true, { done }, "");
}

// ---------------------------------------------------------------------------------------------
// perf

/**
 * Runs the perf harness's local mode (perf/harness/src/local.ts), installing it (and Chromium for
 * it) the first time. Under a host-wide lock (`flock`, where there is one): two runs, from any
 * worktree, would share main's build and skew each other's timings. PERF_LOCK names another lock
 * file; PERF_NO_LOCK=1 runs without one.
 */
function perf(args: string[]): void {
  const harness = join(ROOT, "perf", "harness");
  if (!existsSync(join(harness, "node_modules", "playwright-core"))) {
    console.log("installing the perf harness and its Chromium");
    const npm = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: harness, stdio: "inherit" });
    if (npm.status !== 0) die("npm ci in perf/harness failed");
    const chromium = spawnSync("npx", ["playwright-core", "install", "chromium"], { cwd: harness, stdio: "inherit" });
    if (chromium.status !== 0) die("installing Chromium for the perf harness failed");
  }
  const run = [process.execPath, join(harness, "src", "main.ts"), "local", ...args];
  const lock = process.env.PERF_LOCK ?? join(tmpdir(), "beghu-perf.lock");
  const locked = process.env.PERF_NO_LOCK !== "1" && spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;
  if (locked) console.log(`waiting for ${lock} (another ./dev-ctl perf on this host holds it)`);
  const r = locked
    ? spawnSync("flock", [lock, ...run], { cwd: ROOT, stdio: "inherit" })
    : spawnSync(run[0]!, run.slice(1), { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ---------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const [cmd = "help", ...args] = process.argv.slice(2);
  switch (cmd) {
    case "__supervise":
      return args[0] === "github" ? superviseGitHub() : supervise(args[0] as Scale);
    case "start":
      return start(args);
    case "stop": {
      const { json } = parse(args, []);
      const stopped = await stop();
      return print(json, { stopped }, stopped ? "stopped" : "not running");
    }
    case "status":
      return status(args);
    case "logs":
      return logs(args);
    case "grep":
      return grep(args);
    case "login":
      return login(args);
    case "fake":
      return fake(args);
    case "deploy":
      return deploy(args);
    case "reset":
      return reset(args);
    case "github":
      return github(args);
    case "contract":
      return contract(args);
    case "perf":
      return perf(args);
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      throw new Usage(`unknown command ${cmd}`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof Usage || e instanceof BadArgs) die(`${e.message}\nRun ./dev-ctl help for usage.`, 2);
  die(e instanceof Error ? (e.stack ?? e.message) : String(e));
});
