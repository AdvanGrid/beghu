#!/bin/sh
# Throwaway: fetch issue + all comments with body, body_html, body_text (REST full+json).
set -e
cd "$(dirname "$0")/data"
while read repo num; do
  f=$(echo "$repo-$num" | tr / _)
  gh api -H 'Accept: application/vnd.github.full+json' "repos/$repo/issues/$num" > "$f.issue.json"
  gh api -H 'Accept: application/vnd.github.full+json' --paginate "repos/$repo/issues/$num/comments?per_page=100" | jq -s 'add' > "$f.comments.json"
done <<LIST
rust-lang/rust 38356
nodejs/node 37061
vitejs/vite 11468
tokio-rs/tokio 1879
microsoft/vscode 336320
oven-sh/bun 15087
LIST
for f in *.issue.json; do b=${f%.issue.json}; jq -n --slurpfile i "$f" --slurpfile c "$b.comments.json" '{repo: ($i[0].repository_url|split("/")|.[-2:]|join("/")), number: $i[0].number, body: $i[0].body, body_html: $i[0].body_html, comments: [$c[0][]|{body, body_html}]}'; done | jq -s . > corpus.json
jq '[.[]|{repo,number,n:(.comments|length)}]' corpus.json
