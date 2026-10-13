// App-JWT calls for beghu-dev: node github-app/probe/app.mjs <path> [--all]  (e.g. /app/installations, /app/hook/deliveries)
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
const dir = new URL("../../.dev/github-app", import.meta.url).pathname;
const app = JSON.parse(readFileSync(`${dir}/beghu-dev.json`));
const pem = readFileSync(`${dir}/beghu-dev.pem`, "utf8");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: app.client_id })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(pem, "base64url")}`;
}
export async function api(path, init = {}) {
  const r = await fetch(path.startsWith("http") ? path : `https://api.github.com${path}`, {
    ...init, headers: { authorization: `Bearer ${jwt()}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...init.headers },
  });
  return { status: r.status, link: r.headers.get("link"), json: await r.json().catch(() => null) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let url = process.argv[2], all = [];
  do {
    const r = await api(url);
    if (!Array.isArray(r.json)) { console.log(r.status, JSON.stringify(r.json, null, 2)); process.exit(); }
    all.push(...r.json);
    url = process.argv[3] === "--all" ? r.link?.match(/<([^>]+)>; rel="next"/)?.[1] : null;
  } while (url);
  console.log(JSON.stringify(all, null, 2));
}
