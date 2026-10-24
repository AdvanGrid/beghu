#!/usr/bin/env bash
# Fetches public PR/issue conversation threads with heavy bot/agent traffic and builds
# data/agents.json (bot comments of 1.5-40 KB) and data/kandev-2669.json (one whole real thread).
set -euo pipefail
cd "$(dirname "$0")/data"
mkdir -p raw
fetch() { # owner repo number pages
  for p in $(seq 1 "$4"); do
    f="raw/$1_$2-$3.p$p.json"
    [ -s "$f" ] || gh api "repos/$1/$2/issues/$3/comments?per_page=100&page=$p" > "$f"
  done
}
fetch kdlbs kandev 2669 8                 # claude[bot]/coderabbit/cubic/codex reviews on one PR, 744 comments
fetch objectstack-ai objectstack 6015 3   # claude[bot] triage rounds on a PM "seat" issue (Chinese + code spans)
fetch rmems synthetic-factory 135 1       # a dozen review bots on one PR
fetch manaflow-ai cmux 5553 1
fetch rjmurillo ai-agents 5078 1
node -e '
const fs = require("fs");
const files = fs.readdirSync("raw").sort();
const all = files.flatMap((f) => JSON.parse(fs.readFileSync("raw/" + f)).map((c) => ({ src: f.replace(/\.p\d+\.json$/, ""), login: c.user.login, type: c.user.type, created_at: c.created_at, body: c.body ?? "" })));
const isBot = (c) => c.type === "Bot" || c.login.endsWith("[bot]");
const agents = all.filter((c) => isBot(c) && Buffer.byteLength(c.body) >= 1500 && Buffer.byteLength(c.body) <= 40000);
fs.writeFileSync("agents.json", JSON.stringify(agents));
const kandev = all.filter((c) => c.src === "kdlbs_kandev-2669");
fs.writeFileSync("kandev-2669.json", JSON.stringify(kandev));
const excluded = all.filter((c) => isBot(c) && Buffer.byteLength(c.body) > 40000).map((c) => c.login + " " + Buffer.byteLength(c.body));
console.log("agents", agents.length, "kandev", kandev.length, "excluded >40KB:", excluded);
const by = {}; for (const c of agents) by[c.src + " " + c.login] = (by[c.src + " " + c.login] ?? 0) + 1; console.log(by);
'
