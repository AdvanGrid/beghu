#!/bin/sh
# Smoke-tests a built beghu image: it runs as nonroot on a fresh named volume, serves /healthz,
# /readyz, the shell and its assets (an unknown asset is a 404), keeps its state on the volume,
# and stops cleanly on SIGTERM inside the stop grace period. Removes what it creates.
#
#   deploy/smoke.sh beghu:ci
#
# DOCKER picks the CLI (default docker; podman works too). GitHub is never called: the image
# runs with Fake GitHub's public dev App key against a loopback GITHUB_API_URL, the only place
# beghu accepts that key.
set -eu

image=${1:?usage: deploy/smoke.sh <image>}
docker=${DOCKER:-docker}
root=$(cd "$(dirname "$0")/.." && pwd)
name=beghu-smoke-$$
volume=beghu-smoke-$$
secrets=$(mktemp -d)

cleanup() {
  $docker rm -f "$name" >/dev/null 2>&1 || true
  $docker volume rm -f "$volume" >/dev/null 2>&1 || true
  rm -rf "$secrets"
}
trap cleanup EXIT

fail() {
  echo "smoke: $*" >&2
  $docker logs "$name" >&2 2>&1 || true
  exit 1
}

user=$($docker image inspect -f '{{.Config.User}}' "$image")
case $user in
  "" | root | 0 | 0:*) fail "the image runs as root ($user)" ;;
esac

# Secrets the way a deploy gives them: files mounted read-only, named by <NAME>_FILE.
cp "$root/crates/fake-github/src/dev-app-key.pem" "$secrets/app-key.pem"
head -c 32 /dev/urandom | base64 >"$secrets/token-key"
head -c 24 /dev/urandom | base64 >"$secrets/webhook-secret"
head -c 24 /dev/urandom | base64 >"$secrets/client-secret"
chmod 0755 "$secrets"
chmod 0644 "$secrets"/*

$docker volume create "$volume" >/dev/null
$docker run -d --name "$name" \
  --stop-timeout 30 \
  -p 127.0.0.1::8080 \
  -v "$volume:/data" \
  -v "$secrets:/run/secrets:ro" \
  -e BEGHU_PUBLIC_URL=http://localhost:8080 \
  -e GITHUB_API_URL=http://127.0.0.1:9 \
  -e GITHUB_WEB_URL=http://127.0.0.1:9 \
  -e GITHUB_APP_ID=1000001 \
  -e GITHUB_CLIENT_ID=Iv1.smoke \
  -e GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app-key.pem \
  -e BEGHU_TOKEN_KEY_FILE=/run/secrets/token-key \
  -e GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/webhook-secret \
  -e GITHUB_CLIENT_SECRET_FILE=/run/secrets/client-secret \
  "$image" >/dev/null

port=$($docker port "$name" 8080/tcp | head -n 1 | sed 's/.*://')
[ -n "$port" ] || fail "no published port"
base=http://127.0.0.1:$port

i=0
until curl -fsS "$base/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "no /healthz within 20 s"
  sleep 0.2
done

build=$($docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
  sed -n 's/^BEGHU_BUILD_ID=//p')
curl -fsS "$base/healthz" | grep -q "\"build\":\"$build\"" || fail "/healthz doesn't name build $build"
# Ready once the startup after listening is done (it serves meanwhile).
i=0
until [ "$(curl -fsS "$base/readyz" 2>/dev/null)" = ready ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "/readyz isn't ready within 20 s"
  sleep 0.2
done

shell=$(curl -fsS "$base/")
asset=$(printf '%s' "$shell" | grep -o '/assets/index-[^"]*\.js' | head -n 1)
[ -n "$asset" ] || fail "the shell links no entry chunk"
curl -fsS -D - -o /dev/null -H 'accept-encoding: br' "$base$asset" | tr -d '\r' >"$secrets/headers"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$secrets/headers" ||
  fail "$asset isn't immutable"
grep -qi '^content-encoding: br' "$secrets/headers" || fail "$asset isn't served precompressed"
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/assets/index-00000000.js")
[ "$status" = 404 ] || fail "an unknown asset answered $status, not 404"

# The state is on the volume: the control DB, its first backup, and the build's asset record.
$docker cp "$name:/data/builds/$build.json" - >/dev/null || fail "no build record on the volume"
$docker cp "$name:/data/control.db" - >/dev/null || fail "no control DB on the volume"
# A fresh volume's first backup is taken at once, in the background.
i=0
until $docker cp "$name:/data/backups" - 2>/dev/null | tar -t 2>/dev/null |
  grep -q '/control-[0-9]*T[0-9]*Z\.db$'; do
  i=$((i + 1))
  [ "$i" -lt 50 ] || fail "no first backup within 10 s"
  sleep 0.2
done

start=$(date +%s)
$docker stop "$name" >/dev/null
took=$(($(date +%s) - start))
code=$($docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] || fail "exited with $code after SIGTERM"
# Inside the drain's 25 s (docs/deploy.md, "Stopping").
[ "$took" -lt 25 ] || fail "took ${took} s to stop"

echo "smoke: $image ok (runs as $user, build $build, stopped in ${took} s)"
