#!/bin/sh
# Smoke-tests a built beghu image: it runs as nonroot on a fresh named volume, serves /healthz,
# /readyz, the public site's landing page, the shell at /issues and its assets (an unknown asset
# is a 404), serves the beghu CLI (its install.sh installs this machine's build, which runs and
# names the image's build), keeps its state on the volume, and stops cleanly on SIGTERM inside
# the stop grace period. Removes what it creates.
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
# BEGHU_PUBLIC_URL is the address this machine reaches it at, as in a deploy, so what names the
# host (the canonical URL, install.sh) needs no rewriting here: a free port on loopback, picked
# at random and tried again if it's taken by the time the container binds it.
tries=0
while :; do
  port=$(($(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 20000 + 30000))
  base=http://127.0.0.1:$port
  $docker run -d --name "$name" \
    --stop-timeout 30 \
    -p "127.0.0.1:$port:8080" \
    -v "$volume:/data" \
    -v "$secrets:/run/secrets:ro" \
    -e BEGHU_PUBLIC_URL="$base" \
    -e GITHUB_API_URL=http://127.0.0.1:9 \
    -e GITHUB_WEB_URL=http://127.0.0.1:9 \
    -e GITHUB_APP_ID=1000001 \
    -e GITHUB_CLIENT_ID=Iv1.smoke \
    -e GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app-key.pem \
    -e BEGHU_TOKEN_KEY_FILE=/run/secrets/token-key \
    -e GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/webhook-secret \
    -e GITHUB_CLIENT_SECRET_FILE=/run/secrets/client-secret \
    "$image" >/dev/null && break
  $docker rm -f "$name" >/dev/null 2>&1 || true
  tries=$((tries + 1))
  [ "$tries" -lt 5 ] || fail "docker run failed 5 times (a taken port is retried; its own error is above)"
done

i=0
until curl -fsS "$base/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "no /healthz within 20 s"
  sleep 0.2
done

build=$($docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
  sed -n 's/^BEGHU_BUILD_ID=//p')
# Each answer is read whole before it's searched: `curl | grep -q` would close the pipe at the
# first match, and curl report a body it couldn't finish writing.
health=$(curl -fsS "$base/healthz")
printf '%s' "$health" | grep -q "\"build\":\"$build\"" || fail "/healthz doesn't name build $build"
# Ready once the startup after listening is done (it serves meanwhile).
i=0
until [ "$(curl -fsS "$base/readyz" 2>/dev/null)" = ready ]; do
  i=$((i + 1))
  [ "$i" -lt 100 ] || fail "/readyz isn't ready within 20 s"
  sleep 0.2
done

# The landing page is the prerendered site, naming BEGHU_PUBLIC_URL; the app is at /issues.
landing=$(curl -fsS "$base/")
printf '%s' "$landing" | grep -q "<link rel=\"canonical\" href=\"$base/\">" ||
  fail "/ isn't the landing page with its canonical URL"
shell=$(curl -fsS "$base/issues")
asset=$(printf '%s' "$shell" | grep -o '/assets/index-[^"]*\.js' | head -n 1)
[ -n "$asset" ] || fail "the shell links no entry chunk"
curl -fsS -D - -o /dev/null -H 'accept-encoding: br' "$base$asset" | tr -d '\r' >"$secrets/headers"
grep -qi '^cache-control: public, max-age=31536000, immutable' "$secrets/headers" ||
  fail "$asset isn't immutable"
grep -qi '^content-encoding: br' "$secrets/headers" || fail "$asset isn't served precompressed"
status=$(curl -s -o /dev/null -w '%{http_code}' "$base/assets/index-00000000.js")
[ "$status" = 404 ] || fail "an unknown asset answered $status, not 404"

# The CLI, as an engineer installs it: install.sh from the container, run as served (saved first,
# so a failed download fails here, by curl's own message), into a folder of its own. It
# downloads from the host it names, BEGHU_PUBLIC_URL.
manifest=$(curl -fsS "$base/cli/manifest.json")
printf '%s' "$manifest" | grep -q "\"build\": \"$build\"" ||
  fail "/cli/manifest.json doesn't name build $build"
curl -fsSL -o "$secrets/install.sh" "$base/cli/install.sh" || fail "no /cli/install.sh"
BEGHU_INSTALL_DIR="$secrets/bin" sh "$secrets/install.sh" >/dev/null ||
  fail "install.sh didn't install the CLI"
version=$("$secrets/bin/beghu" --version) || fail "the installed beghu doesn't run"
printf '%s' "$version" | grep -q "^beghu [0-9.]* (build $build, " ||
  fail "the installed beghu names another build ($version)"

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
