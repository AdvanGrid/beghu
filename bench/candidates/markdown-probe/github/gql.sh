#!/bin/sh
# Throwaway: GraphQL cost, wall time and response bytes, body vs bodyHTML.
# usage: gql.sh <owner> <name> <issues> <comments>
o=$1 n=$2 I=$3 C=$4
for f in "body" "bodyHTML" "body bodyHTML"; do
  q="query { rateLimit{cost} repository(owner:\"$o\",name:\"$n\"){ issues(first:$I, states:CLOSED){ nodes{ number $f comments(first:$C){ nodes{ $f } } } } } }"
  out="gql-$n-$I-$C-$(echo $f|tr ' ' _).json"
  s=$(date +%s%N); gh api graphql -f query="$q" > "$out" 2>/dev/null; e=$(date +%s%N)
  printf '%-14s cost=%s time=%.1fs bytes=%s gzip=%s comments=%s\n' "$f" "$(jq .data.rateLimit.cost $out)" "$(awk "BEGIN{print ($e-$s)/1e9}")" "$(wc -c < $out)" "$(gzip -9c $out | wc -c)" "$(jq '[.data.repository.issues.nodes[].comments.nodes|length]|add' $out)"
done
