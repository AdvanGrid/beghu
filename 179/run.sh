#!/usr/bin/env bash
# Evidence for #179: drive the beghu CLI against a 1k stack and capture its screens.
set -u
cd "$(dirname "$0")/../../.."
E=.dev/tmp/ev179
export TMPDIR=$PWD/.dev/tmp CARGO_PROFILE_DEV_DEBUG=0 DEV_APP_PORT=24373 DEV_SERVER_PORT=24380 DEV_FAKE_PORT=24390 DEV_FAKE_CONTROL_PORT=24391
systemctl --user stop beghu-cli-dev 2>/dev/null; systemctl --user reset-failed beghu-cli-dev 2>/dev/null
systemd-run --user --unit=beghu-cli-dev -p RemainAfterExit=yes --working-directory=$PWD -E PATH="$PATH" -E HOME="$HOME" -E TMPDIR=$TMPDIR -E CARGO_PROFILE_DEV_DEBUG=0 -E DEV_APP_PORT=24373 -E DEV_SERVER_PORT=24380 -E DEV_FAKE_PORT=24390 -E DEV_FAKE_CONTROL_PORT=24391 sh -c './dev-ctl start --scale 1k && ./dev-ctl reset' >/dev/null
sleep 20; for i in $(seq 300); do ./dev-ctl status 2>&1 | grep -q 'ready)' && [ -s .dev/data/analyses/seeded.json ] && break; sleep 4; done
{
  echo '$ ./dev-ctl login tomsj      # also signs the CLI in'; ./dev-ctl login tomsj 2>&1
  echo; echo '$ ./dev-ctl cli --version'; ./dev-ctl cli --version 2>&1
  echo; echo '$ ./dev-ctl cli status'; ./dev-ctl cli status 2>&1
  W=$(mktemp -d -p $TMPDIR); echo; echo '$ cd <empty dir> && beghu analyse AdvanGrid/beghu#191 --yes   (first 25 lines)'
  (cd $W && $OLDPWD/dev-ctl cli analyse 'AdvanGrid/beghu#191' --yes 2>&1 | head -25)
  echo; echo '$ ls -la .beghu/run-*/'; ls -la $W/.beghu/run-*/ | sed "s#$W#.#"
  echo; echo '$ beghu analyse end'; (cd $W && $OLDPWD/dev-ctl cli analyse end 2>&1)
  rm -rf $W
} > $E/cli-transcript.txt 2>&1
# A pending device login, approved in the browser.
CRED=$TMPDIR/ev179-cred.toml; rm -f $CRED
BEGHU_CREDENTIALS=$CRED ./dev-ctl cli login --no-browser --name evidence-laptop > $E/login-out.txt 2>&1 &
LP=$!
for i in $(seq 60); do grep -qE '[B-Z]{4}-[B-Z]{4}' $E/login-out.txt && break; sleep 1; done
CODE=$(grep -oE '[B-Z]{4}-[B-Z]{4}' $E/login-out.txt | head -1)
cd web && flock /tmp/claude-1001/beghu-e2e.lock node ../$E/shots.mjs ../$E "$CODE" > ../$E/shots-out.txt 2>&1; cd ..
wait $LP; echo "exit $?" >> $E/login-out.txt
./dev-ctl stop >/dev/null 2>&1; systemctl --user stop beghu-cli-dev
echo DONE
