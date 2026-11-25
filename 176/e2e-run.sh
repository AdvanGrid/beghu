#!/usr/bin/env bash
# Slice 2 (#176) end to end on a ./dev-ctl stack (fixture 1k): the browser starts a run, an agent
# fetches the run's files with curl, validates with the served validate.mjs, uploads, and the
# view reads the graph and claims. Then the refusals.
set -uo pipefail
APP=http://localhost:14173; CTL=http://127.0.0.1:14191; J=/tmp/ev176.jar
S=/home/tomsj/.t3/worktrees/beghu/t3-680716b5/crates/analysis/tests/sample
W=$(mktemp -d); cd "$W"
say() { printf '\n## %s\n' "$*"; }
show() { printf '$ %s\n' "$*"; }
N=$(curl -s -b $J "$APP/api/issues?q=is%3Apr%20is%3Aopen%20repo%3Aacme%2Fweb" | python3 -c 'import json,sys;print(json.load(sys.stdin)["rows"][0]["number"])')
DESC=$(python3 -c "import json;print(json.dumps(json.load(open('$S/analysis.json'))['pr']['description']))")
say "Setup through Fake GitHub's control port: acme/web#$N gets the sample's description and a push"
curl -s -X POST $CTL/edit -H 'content-type: application/json' -d "{\"repo\":\"acme/web\",\"number\":$N,\"body\":$DESC}" >/dev/null
curl -s -X POST $CTL/push -H 'content-type: application/json' -d "{\"repo\":\"acme/web\",\"number\":$N,\"sha\":\"2222222222222222222222222222222222222222\",\"files\":[{\"filename\":\"api/main.go\",\"status\":\"modified\",\"additions\":1,\"deletions\":0},{\"filename\":\"api/orders/refund.go\",\"status\":\"added\",\"additions\":21,\"deletions\":0}]}"; echo
say "1. The browser starts a run: POST /api/acme/web/pulls/$N/runs"
curl -s -b $J -H "Origin: $APP" -H "x-beghu-account: 1000" -X POST "$APP/api/acme/web/pulls/$N/runs" > start.json
python3 -c 'import json;d=json.load(open("start.json"));print("run:",d.get("run"),"\nexpiresAt:",d.get("expiresAt"),"\nprompt:",d.get("prompt","").replace(d.get("token","~"),"<token>"))'
T=$(python3 -c 'import json;print(json.load(open("start.json"))["token"])'); R="$APP/api/runs/$T"
say "2. The agent fetches every run file with curl (no cookie)"
for f in instructions pr.json schema.ts validate.mjs merge.mjs previous-ids.json vocabulary.json; do
  printf '%-18s %s\n' "$f" "$(curl -s -o "$f" -w '%{http_code} %{size_download} bytes %{content_type}' "$R/$f")"; done
echo; echo "instructions, first lines (token redacted):"; head -n 14 instructions | sed "s/$T/<token>/g"
echo; echo "pr.json, pinned:"; python3 -c 'import json;p=json.load(open("pr.json"));print({k:p[k] for k in ("repo","number","headSha","base","stats")});print("files:",p["files"]);print("issues:",len(p["issues"]),"unreached:",p["unreached"])'
say "3. The agent validates with the served validate.mjs"
cp "$S/analysis.json" a.json; python3 -c "import json;a=json.load(open('a.json'));a['carried']=[];a['pr']['number']=$N;json.dump(a,open('a.json','w'))"
show "node validate.mjs a.json base head --pr pr.json"; node validate.mjs a.json "$S/base" "$S/head" --pr pr.json | tail -1
say "4. Upload, gzipped, Beghu-Snippets: checked"
gzip -9 -k a.json
show "curl -X POST \$RUN/analysis -H 'Content-Encoding: gzip' -H 'Beghu-Snippets: checked' --data-binary @a.json.gz"
curl -s -w '\nHTTP %{http_code}\n' -X POST "$R/analysis" -H 'content-type: application/json' -H 'Content-Encoding: gzip' -H 'Beghu-Snippets: checked' --data-binary @a.json.gz
say "5. The view reads the graph, then revisits with its ETag"
curl -s -b $J -D h1 -o g.json -H 'accept-encoding: br' "$APP/api/acme/web/pulls/$N/analysis"; grep -iE '^(HTTP|etag|cache-control|content-encoding|content-length)' h1
E=$(grep -i '^etag' h1 | cut -d' ' -f2 | tr -d '\r')
curl -s -b $J -o /dev/null -w 'revisit with If-None-Match %{http_code}\n' -H "If-None-Match: $E" "$APP/api/acme/web/pulls/$N/analysis"
curl -s -b $J "$APP/api/acme/web/pulls/$N/analysis" > graph.json
python3 -c 'import json;g=json.load(open("graph.json"));print("envelope keys:",sorted(k for k in g if k!="analysis"));print("claimsUrl:",g["claimsUrl"]);a=g["analysis"];print("nodes",len(a["nodes"]),"lines",len(a["edges"]),"claim stub:",a["claims"][0])'
CU=$(python3 -c 'import json;print(json.load(open("graph.json"))["claimsUrl"])')
curl -s -b $J -D h2 -o c.json "$APP$CU"; grep -iE '^(HTTP|cache-control)' h2; python3 -c 'import json;c=json.load(open("c.json"));c=c.get("claims",c);print(len(c),"claims, first:",json.dumps(c[0])[:220])'
say "6. Refusals"
python3 -c "import json;a=json.load(open('a.json'));a['pr']['headSha']='3'*40;json.dump(a,open('wrong-head.json','w'))"
printf 'wrong head SHA      '; curl -s -o r.json -w '%{http_code} ' -X POST "$R/analysis" -H 'Beghu-Snippets: checked' --data-binary @wrong-head.json; python3 -c 'import json;print(json.dumps(json.load(open("r.json")))[:200])'
python3 -c "import json;a=json.load(open('a.json'));a['edges'][0].pop('uses',None);json.dump(a,open('bad.json','w'))"
printf 'fails a check       '; curl -s -o r.json -w '%{http_code} ' -X POST "$R/analysis" -H 'Beghu-Snippets: checked' --data-binary @bad.json; python3 -c 'import json;r=json.load(open("r.json"));print([(e["rule"],e["path"]) for e in r.get("report",r).get("errors",[])][:3])'
printf 'no Beghu-Snippets   '; curl -s -o r.json -w '%{http_code} ' -X POST "$R/analysis" --data-binary @a.json; head -c 160 r.json; echo
# Straight to the server: Vite's dev proxy turns the early 413 into a 502.
head -c 9000000 /dev/urandom | base64 -w0 > big.json
printf "over 8 MB on wire   "; curl -s -o r.json -w "%{http_code} " -X POST "http://localhost:14180/api/runs/$T/analysis" -H 'Beghu-Snippets: checked' --data-binary @big.json; head -c 160 r.json; echo
printf 'bad token           '; curl -s -o /dev/null -w '%{http_code}\n' "$APP/api/runs/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/pr.json"
say "7. Starting a new run supersedes the old one"
curl -s -b $J -H "Origin: $APP" -H "x-beghu-account: 1000" -X POST "$APP/api/acme/web/pulls/$N/runs" -o /dev/null -w 'new run %{http_code}\n'
printf 'old token now       '; curl -s -o r.json -w '%{http_code} ' "$R/pr.json"; head -c 200 r.json; echo
say "8. The browser ends the live run"
curl -s -b $J -H "Origin: $APP" -H "x-beghu-account: 1000" -X DELETE -o /dev/null -w 'DELETE run %{http_code}\n' "$APP/api/acme/web/pulls/$N/run"
say "9. The account's live stream hears the run's changes (event: analysis)"
timeout 12 curl -s -N -b $J -H "x-beghu-account: 1000" "$APP/api/stream" > stream.txt &
sleep 2
curl -s -b $J -H "Origin: $APP" -H "x-beghu-account: 1000" -X POST "$APP/api/acme/web/pulls/$N/runs" > s2.json
T2=$(python3 -c 'import json;print(json.load(open("s2.json"))["token"])')
curl -s -o pr2.json "$APP/api/runs/$T2/pr.json"
curl -s -o /dev/null -w 'upload %{http_code}\n' -X POST "$APP/api/runs/$T2/analysis" -H 'Beghu-Snippets: not-checked' --data-binary @a.json
curl -s -b $J -H "Origin: $APP" -H "x-beghu-account: 1000" -X DELETE -o /dev/null "$APP/api/acme/web/pulls/$N/run"
sleep 3; wait
grep -A1 '^event: analysis' stream.txt | grep '^data' | sed 's/^/  /'
say "10. Disconnect deletes the account's analyses"
printf 'graph before        '; curl -s -b $J -o /dev/null -w '%{http_code}\n' "$APP/api/acme/web/pulls/$N/analysis"
curl -s -b $J -c $J -H "Origin: $APP" -X POST -d 'account=1000' -o /dev/null -w 'POST /auth/disconnect %{http_code}\n' "$APP/auth/disconnect"
curl -s -L -c $J -b $J -o /dev/null -w 'signed in again %{http_code}\n' "$APP/auth/login?login=tomsj"
printf 'graph after         '; curl -s -b $J -w ' %{http_code}\n' "$APP/api/acme/web/pulls/$N/analysis"
