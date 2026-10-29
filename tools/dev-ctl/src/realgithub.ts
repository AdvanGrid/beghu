// `./dev-ctl github setup` and `./dev-ctl contract`: the commands that reach real GitHub (or, for
// checking them, a Fake GitHub).
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { ROOT, running, urls } from "./config.ts";
import { APP_FILE, KEY_FILE, SANDBOX, SetupError, check, readDevApp, save } from "./github.ts";

export { readDevApp };

/** A command line the command can't take: main prints it with the usage hint. */
export class BadArgs extends Error {}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** `./dev-ctl github setup …`. */
export async function github(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "setup") throw new BadArgs("usage: ./dev-ctl github setup [--app-json FILE] [--key PEM] [--app-id ID] [--client-id ID] [--client-secret S] [--webhook-secret S] --smee URL [--repos R,…]");
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        "app-json": { type: "string" },
        key: { type: "string" },
        "app-id": { type: "string" },
        "client-id": { type: "string" },
        "client-secret": { type: "string" },
        "webhook-secret": { type: "string" },
        smee: { type: "string" },
        repos: { type: "string" },
        // Checks the setup against a Fake GitHub instead (its API URL) and its sandbox repo.
        api: { type: "string" },
        sandbox: { type: "string" },
        json: { type: "boolean" },
      },
    }));
  } catch (e) {
    throw new BadArgs((e as Error).message);
  }
  let checked;
  try {
    checked = await check({
      appJson: values["app-json"],
      key: values.key,
      appId: values["app-id"],
      clientId: values["client-id"],
      clientSecret: values["client-secret"],
      webhookSecret: values["webhook-secret"],
      smee: values.smee,
      repos: values.repos,
      sandbox: values.sandbox ?? SANDBOX,
      api: (values.api ?? "https://api.github.com").replace(/\/$/, ""),
    });
  } catch (e) {
    if (e instanceof SetupError) fail(`github setup: ${e.message}`);
    fail(`github setup: couldn't reach GitHub: ${(e as Error).message}`);
  }
  save(checked);
  const { app } = checked;
  const callback = `${urls().app}/auth/callback`;
  const warnings = [
    ...(checked.missingEvents.length
      ? [`the App isn't subscribed to ${checked.missingEvents.join(", ")} (github-app/manifest.json asks for them): add them in its settings, or their webhooks never arrive`]
      : []),
    ...(checked.hookUrl !== null && checked.hookUrl !== app.smee_url
      ? [`the App's webhook URL is ${checked.hookUrl}, not ${app.smee_url}: start --github would hear nothing`]
      : []),
  ];
  const text = [
    `${app.slug} (id ${app.id}, owned by ${checked.owner}) checked: it minted an installation token for ${values.sandbox ?? SANDBOX} (installation ${app.installation_id}).`,
    `Saved to ${APP_FILE.slice(ROOT.length + 1)} and ${KEY_FILE.slice(ROOT.length + 1)} (yours alone; never committed).`,
    `The App's callback URL must be ${callback}, and its setup URL ${urls().app}/auth/setup.`,
    ...warnings.map((w) => `warning: ${w}`),
    "Next: ./dev-ctl start --github",
  ].join("\n");
  if (values.json) console.log(JSON.stringify({ app: { ...app, client_secret: undefined, webhook_secret: undefined }, warnings, callback }, null, 2));
  else console.log(text);
}

/** `./dev-ctl contract read|write …` and `contract record read|write …`: the contract binary. */
export async function contract(args: string[]): Promise<void> {
  const pass: string[] = [];
  let fake = false;
  for (const a of args) {
    if (a === "--fake") fake = true;
    else pass.push(a);
  }
  const [first, second] = pass;
  const kind = first === "record" ? second : first;
  if (kind !== "read" && kind !== "write") {
    throw new BadArgs("usage: ./dev-ctl contract read|write [--fake] [--report] [OPTIONS], or contract record read|write [--fake]");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (fake) {
    const r = running();
    if (!r || r.state?.mode !== "fixture") fail("--fake checks against the running stack's Fake GitHub: ./dev-ctl start first");
    pass.push("--fake", urls().fake);
  } else {
    const app = readDevApp();
    if (!app) fail("no dev App set up yet: run ./dev-ctl github setup, or pass --fake");
    env.CONTRACT_API_URL ??= app.api;
    env.CONTRACT_APP_ID ??= app.id;
    env.CONTRACT_APP_KEY_FILE ??= KEY_FILE;
    env.CONTRACT_CLIENT_ID ??= app.client_id;
    env.CONTRACT_CLIENT_SECRET ??= app.client_secret;
    env.CONTRACT_REPOS ??= app.repos.join(",");
    env.CONTRACT_SANDBOX ??= SANDBOX;
  }
  const res = spawnSync("cargo", ["run", "--quiet", "-p", "contract", "--", ...pass], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
  process.exit(res.status ?? 1);
}
