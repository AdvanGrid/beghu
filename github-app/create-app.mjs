#!/usr/bin/env node
// Register a beghu GitHub App from manifest.json through the manifest flow.
//
//   node github-app/create-app.mjs --name beghu-dev --hook-url https://smee.io/xyz \
//     [--host localhost] [--callback-url http://HOST:3000/auth/callback] [--org ORG] [--port 4567]
//
// Opens a local page that posts the manifest to GitHub. After you confirm the app on GitHub,
// the code is exchanged for the app's credentials, which are written to .dev/github-app/<name>.json
// and .dev/github-app/<name>.pem (both gitignored).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    name: { type: "string" },
    "hook-url": { type: "string" },
    host: { type: "string", default: "localhost" },
    "callback-url": { type: "string", multiple: true },
    org: { type: "string" },
    port: { type: "string", default: "4567" },
  },
});
if (!args.name || !args["hook-url"]) {
  console.error("--name and --hook-url are required");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;
const port = Number(args.port);
const state = randomUUID();
const manifest = {
  ...JSON.parse(readFileSync(new URL("manifest.json", import.meta.url))),
  name: args.name,
  hook_attributes: { url: args["hook-url"], active: true },
  redirect_url: `http://${args.host}:${port}/created`,
  callback_urls: args["callback-url"] ?? [`http://${args.host}:3000/auth/callback`],
};
const target = args.org
  ? `https://github.com/organizations/${args.org}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;
const escape = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${args.host}:${port}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<form method="post" action="${target}">
      <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
      <button>Create ${escape(args.name)} on GitHub</button></form>
      <script>document.forms[0].submit()</script>`);
    return;
  }
  if (url.pathname !== "/created") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch");
    return;
  }
  const resp = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  const app = await resp.json();
  if (!resp.ok) {
    res.writeHead(500).end(JSON.stringify(app));
    console.error(app);
    process.exit(1);
  }
  const dir = `${root}.dev/github-app`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${app.slug}.pem`, app.pem, { mode: 0o600 });
  delete app.pem;
  writeFileSync(`${dir}/${app.slug}.json`, JSON.stringify(app, null, 2), { mode: 0o600 });
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`Created ${escape(app.slug)} (id ${app.id}). Install it: <a href="${app.html_url}/installations/new">${app.html_url}/installations/new</a>`);
  console.log(`Created ${app.slug} (id ${app.id}); credentials in ${dir}/${app.slug}.{json,pem}`);
  console.log(`Install: ${app.html_url}/installations/new`);
  server.close();
});
server.listen(port, "0.0.0.0", () => console.log(`Open http://${args.host}:${port}/ to create ${args.name}`));
