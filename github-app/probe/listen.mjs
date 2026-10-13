// Listen to a smee.io channel and append each webhook as one JSON line with receipt times.
import { appendFileSync } from "node:fs";
const [channel, out] = process.argv.slice(2);
const res = await fetch(channel, { headers: { accept: "text/event-stream" } });
const dec = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
    const ev = block.match(/^event: ?(.*)$/m)?.[1];
    if (!data || ev === "ready" || ev === "ping") { console.log("sse", ev); continue; }
    const now = Date.now();
    let m; try { m = JSON.parse(data); } catch { continue; }
    const b = m.body ?? {};
    const rec = {
      local_ms: now, smee_ms: m.timestamp,
      delivery: m["x-github-delivery"], event: m["x-github-event"], action: b.action,
      repo: b.repository?.full_name, issue: b.issue?.number, issue_updated_at: b.issue?.updated_at,
      body: b,
    };
    appendFileSync(out, JSON.stringify(rec) + "\n");
    console.log(new Date(now).toISOString(), rec.event, rec.action, rec.repo, rec.issue, `smee->local ${now - m.timestamp}ms`);
  }
}
