# Deploying beghu

beghu runs as one container with one block-storage volume, configured from the environment only.
Exactly one instance runs per deployment: each account's mirror is a SQLite file and the GitHub App
has one webhook URL. A deploy stops the old container, then starts the new one. Tabs reconnect
within a few seconds, and webhooks GitHub sent meanwhile are caught up by redelivery and sweeps.

This page is the recipe: the image, its environment, the volume, the stop grace period, the edge
in front of it, backups and restore. `deploy/compose.yaml` is a worked example and
`deploy/smoke.sh` checks a built image.

## The image

```sh
docker build --build-arg BEGHU_BUILD_ID="$(git rev-parse HEAD)" -t beghu:"$(git rev-parse HEAD)" .
deploy/smoke.sh beghu:"$(git rev-parse HEAD)"
```

The `Dockerfile` has three stages:

1. `node:24-bookworm-slim` runs `vite build`. The output has the hashed assets with `.br` and
   `.gz` siblings at maximum compression, and `.vite/manifest.json`, which the server reads at
   startup to find the issue panel's chunk.
2. `rust:1-slim-bookworm` runs `cargo build --release --locked -p beghu`. It's glibc, not musl,
   because musl's allocator is slow under multi-threaded tokio and SQLite. The bundled SQLite gets
   its pinned flags from `.cargo/config.toml`, and the migrations are compiled in.
3. `gcr.io/distroless/cc-debian12:nonroot` holds `/app/beghu` and the web build in `/app/web`. It
   runs as `nonroot` (uid 65532), has `/data` as its volume and serves plain HTTP on 8080.

Each base image is pinned by the digest of its multi-arch index. Bump a tag and its digest
together (`skopeo inspect --raw docker://<image:tag> | sha256sum`). The npm and cargo caches are
BuildKit cache mounts, so a rebuild recompiles only what changed.

`BEGHU_BUILD_ID` is the git SHA, baked into the image's environment. The build fails without it.
`/healthz` reports it, and so do the `X-Beghu-Build` header and the asset record on the volume.
Use it as the image tag too.

The build context leaves out `deploy/secrets/`, every `*.pem` and `.env*` (`.dockerignore`), so
a secret kept in the checkout never lands in a build layer.

CI builds the image and runs `deploy/smoke.sh` against it (the `image` job) on main, and on PRs
that touch the `Dockerfile`, `deploy/`, `Cargo.lock` or the web build's inputs. The smoke test
checks that the image:

- runs as non-root on a fresh named volume;
- reads its secrets from `_FILE` mounts;
- serves `/healthz`, `/readyz`, the shell, and a precompressed immutable asset;
- answers 404 for an unknown asset;
- keeps its state on the volume, the first backup included;
- exits 0 within the drain after SIGTERM.

## Environment

A missing or malformed value stops startup with a message that names the variable (exit code 2).
Every secret also accepts `<NAME>_FILE`, the path of a file holding it, trimmed. An empty secret is
refused either way.

| Variable | Required | What it is |
|---|---|---|
| `BEGHU_PUBLIC_URL` | yes | Where browsers reach beghu (`https://beghu.example.com`). It's the `Origin` beghu accepts writes from, and it sets the OAuth callback and the setup URL. |
| `BEGHU_DATA_DIR` | yes (image: `/data`) | The volume. See [The volume](#the-volume). |
| `BEGHU_TOKEN_KEY` | yes, secret | The master key: at least 32 random bytes, base64. HKDF derives the key that encrypts GitHub tokens in the control DB and the key that signs image-proxy URLs. Make one with `head -c 32 /dev/urandom \| base64`. |
| `GITHUB_APP_ID` | yes | The GitHub App's numeric id. |
| `GITHUB_CLIENT_ID` | yes | The App's OAuth client id (`Iv1.…`). |
| `GITHUB_CLIENT_SECRET` | yes, secret | The App's OAuth client secret. |
| `GITHUB_APP_PRIVATE_KEY` | yes, secret | The App's private key, PEM as GitHub hands it out (PKCS#1 or PKCS#8). In an env var, escaped newlines (`\n`) are accepted; `_FILE` is the usual route. |
| `GITHUB_WEBHOOK_SECRET` | yes, secret | The App's webhook secret, which signs every delivery to `/webhook`. |
| `GITHUB_APP_SLUG` | no | The App's URL name (`github.com/apps/<slug>`). It's where installing starts when GitHub can't be asked. |
| `PORT` | no (image: 8080) | The plain-HTTP port. Without the image's setting it's 3000. |
| `BEGHU_BUILD_ID` | no (image: the git SHA, a required build arg) | Letters, digits, `.`, `_` and `-`, up to 64. `dev` if unset. |
| `BEGHU_WEB_DIR` | no (image: `/app/web`) | The `vite build` output. Without it the server answers only `/api`, `/auth`, `/webhook` and the probes, as in dev, where Vite serves the app. |
| `GITHUB_API_URL` | no | Default `https://api.github.com`. Dev and CI point it at Fake GitHub. |
| `GITHUB_WEB_URL` | no | Default `https://github.com`. It serves the OAuth pages. |
| `GITHUB_ATTACHMENTS_URL` | no | Default `https://private-user-images.githubusercontent.com`: where the attachment URLs GitHub mints into a post's HTML point. The attachment route fetches from nowhere else. Dev and CI point it at Fake GitHub's `/private-user-images`. |
| `BEGHU_DEV_IMAGE_HOSTS` | no, dev only | Loopback `ip:port`s, comma-separated, that the image proxy may fetch from despite its address guard: Fake GitHub's stand-in for the web's image hosts. beghu refuses to start with it set unless `GITHUB_API_URL` is on this machine. Never set it in production. |
| `BEGHU_MIRROR_CONNECTIONS` | no | The cap on open mirror connections across all accounts. Default 256. |

Fake GitHub's dev App key is committed to this repo (`crates/fake-github/src/dev-app-key.pem`),
so it's public. beghu refuses to start with it unless `GITHUB_API_URL` is on this machine
(`localhost` or a loopback address). A real deployment needs its own App and key.

### Secrets

- Keep the four secrets out of the image and out of the repo: mount them as files and name them
  with `<NAME>_FILE` (Docker or Compose secrets, Kubernetes Secrets mounted as a volume). Plain
  env vars work, but show up in `docker inspect` and process listings.
- Keep `BEGHU_TOKEN_KEY` apart from the volume and its backups. A backup holds GitHub tokens
  encrypted under that key, so either one alone is useless.
- Losing `BEGHU_TOKEN_KEY` costs every account a sign-in, nothing more: the stored tokens can no
  longer be read.
- There's no rotation in v1. GitHub lets an App have two private keys, so rotating that one later
  only needs the config to accept a list.

## The volume

`BEGHU_DATA_DIR` must be block storage: a local disk, or one network-attached volume with a single
writer (ext4 or xfs, Kubernetes `ReadWriteOnce`, k3s `local-path`, Longhorn). SQLite's WAL needs
POSIX locks and a shared-memory map, which network filesystems don't give reliably. At startup
beghu checks the directory's filesystem with `statfs`. It refuses to start on NFS, SMB/CIFS, 9p
(WSL and Podman machine shares), CephFS, AFS, Coda, NCP and Lustre, and names the filesystem. On
FUSE it starts with a warning: `statfs` can't tell a local FUSE overlay from sshfs or s3fs, and
the network ones aren't safe for SQLite.

What's on it:

| Path | What it is |
|---|---|
| `control.db` (with `-wal`, `-shm` while running) | Accounts, sessions, encrypted tokens, synced repos, webhook deliveries, preferences. The only state that can't be rebuilt. |
| `backups/` | The control DB's backups. See [Backups and restore](#backups-and-restore). |
| `mirrors/<github user id>.db` | Each account's mirror. It's disposable: it's rebuilt from GitHub if it's lost, and never backed up. |
| `assets/` | The web build's hashed assets, this build's and the ones still kept from earlier builds. |
| `builds/<build id>.json` | Each build's asset list, and when a later build superseded it. |

The image's `/data` is owned by uid 65532, so a fresh named volume starts out writable. A host
directory bind-mounted there must be writable by uid 65532 (`chown -R 65532:65532 <dir>`).

Disk: about 0.5 GB per account with 20k issues and 20k PRs, plus room for one re-import at a time,
whose new mirror is built beside the old one. Ten GB covers about five accounts. These numbers are
placeholders until real builds are measured.

## Starting and stopping

The spec's startup order (#86) is:

1. Migrate the control DB, after a `VACUUM INTO` backup (`backups/control-before-v<N>.db`). A
   failed migration stops startup, and so does a database newer than the build. (Before this,
   beghu checks the volume.)
2. Copy this build's assets to the volume, and prune the old ones.
3. Delete dormant accounts' mirror files.
4. Listen.
5. Resume the webhook deliveries that were acknowledged but never processed, ahead of any that
   arrived since step 4, then start reconciliation: its first redelivery run asks GitHub again for
   the deliveries it sent during the downtime, and its sweeps follow. Both run in the background,
   so readiness doesn't wait on GitHub.
6. Start the migration walker, which migrates active mirrors one at a time.

Then the other jobs start: the hourly backup, asset pruning, and the accounts' repo re-reads. An
import a restart cut short resumes at its account's next re-read of its repos.

Step 3 covers accounts that lost access and dormant ones: an account nobody has used beghu as for
30 days goes dormant at the daily accounts check, which deletes its mirror (its next use, or its
next sign-in, re-imports it). Step 6's walker brings each active account's mirror up to the
build's schema after a deploy with a new in-place mirror migration, one at a time and the most
recently used first, so a returning user seldom waits on "Updating mirror…". A mirror it hasn't
reached yet still migrates on its first use. A `.rebuild.sql` migration isn't walked: each mirror
it replaces is rebuilt and re-imported on its account's first use.

`/healthz` answers 200 with `{"build": "<build id>"}` whenever the process answers. It never
touches a database, so use it for liveness. `/readyz` answers 503 while the startup after
listening (step 5 on) runs, 200 once it's done, and 503 again while beghu drains, so use it for
readiness. beghu serves from step 4: a webhook delivery that comes in before step 5 is acked and
waits behind the resumed ones.

### Stopping

The figures, which the code, the `Dockerfile` and `deploy/compose.yaml` refer to:

| What | How long |
|---|---|
| The drain, start to exit | at most **25 s** |
| Of which steps 1 to 4 and the server's stop | at most 22 s |
| Of which the WAL checkpoint (step 5) | at most 3 s |
| The platform's stop grace period | at least **30 s** |

On SIGTERM, beghu drains:

1. `/readyz` answers 503.
2. The live streams (`/api/stream`) close, and tabs reconnect to the next instance.
3. New writes get 503 with `retry-after`, and the writes already in flight get to finish their
   GitHub call and mirror write.
4. The jobs stop at their next await: the import, the relationship read-backs, the webhook
   dispatcher, the repo re-reads, backups and asset pruning. Each one's work is picked up at the
   next start. An import a restart cut short resumes, and a webhook delivery not yet settled is
   replayed. A token refresh already under way is waited for, since GitHub has already spent
   the old refresh token.
5. beghu stops taking connections. It then seals each database, so nothing still running can
   write to it, lets the write in flight finish, folds the WAL into the file, and exits 0. The
   databases are checkpointed all at once, so one kept waiting doesn't use up the others' time,
   and a control DB backup under way is cut short (its half-written copy is deleted; the next
   start takes one if the newest is over an hour old). A checkpoint a reader kept from
   completing is logged; its WAL stays beside the file, whole, and the next start replays it.

A second SIGTERM during the drain exits at once.

**Set the platform's stop grace period to at least 30 s.** Docker's default is 10 s, which kills
the drain partway:

- `docker run --stop-timeout 30`;
- `stop_grace_period: 30s` in Compose;
- `terminationGracePeriodSeconds: 30` on Kubernetes.

## The edge

The container serves plain HTTP/1.1 and never does TLS. It doesn't speak h2c, so the edge talks
HTTP/1.1 to it. Whatever sits in front of
it (Cloudflare proxied DNS, a Kubernetes ingress, Caddy, nginx) must:

- **Give browsers HTTP/2** (or HTTP/3). The live stream holds a connection open per tab, so
  HTTP/1.1's six-connection limit runs out.
- **Not buffer `/api/stream`.** It's Server-Sent Events. beghu sends `X-Accel-Buffering: no` and
  `Cache-Control: no-store` on it, which nginx honours. Elsewhere, turn response buffering off
  for that path.
- **Have an idle timeout over 15 s.** The stream sends a heartbeat every 15 s.
- **Keep `Host` and `Origin` as the browser sent them, and set `X-Forwarded-Proto`.** beghu
  refuses writes whose `Origin` isn't `BEGHU_PUBLIC_URL`'s.
- **Pass response bodies and encodings through unchanged.** beghu compresses for itself: br or gzip
  by `Accept-Encoding`, on the fly for the API and the shell, and from the precompressed siblings
  for assets. So no recompression, no minifying, and no HTML or JS rewriting (Cloudflare's Rocket
  Loader and Auto Minify off).
- **Pass beghu's own 4xx and 5xx responses through as they are**, with no custom error pages.
  beghu's errors carry typed JSON bodies that the app acts on: 503 `github_down` and `unavailable`
  (with `retry-after`), 424 `maybe_posted`, 409 `conflict`, and the rest. A replaced body
  turns a recoverable state into a generic failure.
- **Add no cache rules for HTML or `/api/*`.** beghu sets its own `Cache-Control`: `max-age=300`
  on the shell, `no-store` on the API, and `public, max-age=31536000, immutable` on `/assets/*`.
- **Leave `POST /webhook` unchallenged** by WAF, bot and rate rules. GitHub can't answer a
  challenge. beghu checks each delivery's signature itself.

The health endpoints are for the platform. They can stay internal.

## Backups and restore

Every hour beghu writes a `VACUUM INTO` copy of the control DB to
`backups/control-<UTC time>.db` (for example `control-20261027T140000Z.db`). The copy reads a
snapshot on a connection of its own, so writes carry on while it runs. It keeps the 24 newest
(hourly), plus, from the ones older than those, the newest of each of the 7 latest days that have
one (daily), and deletes the rest, along with any backup a crash left half written (`.tmp`). A start takes one at once if the newest is over an
hour old. The copy taken before a migration and any other file in `backups/` are left alone.
Mirrors are never backed up.

Disk: at most 31 copies (24 hourly, then 7 daily) of the control DB, each about its size after `VACUUM`
(no free pages), plus one copy per migration. The control DB holds accounts, sessions, tokens,
picks and the last four days of webhook deliveries, so it's usually a few MB, and 31 copies a
few hundred MB at most.

beghu doesn't copy backups off the volume. Use volume snapshots or a periodic `rsync` of
`backups/` for that, and keep `BEGHU_TOKEN_KEY` elsewhere.

To restore:

1. Stop beghu (with the grace period, so the drain checkpoints the WAL).
2. Copy a backup over `control.db`, and delete `control.db-wal` and `control.db-shm` if they're
   there. Everything on the volume must stay owned by uid 65532, the image's user.
3. Start beghu.

The image has no shell, so step 2 runs in a helper container on the same volume, as uid 65532.
With Compose's `beghu-data` volume (Compose prefixes it with the project name, as
`docker volume ls` shows):

```sh
docker compose -f deploy/compose.yaml stop beghu
docker run --rm --user 65532:65532 -v deploy_beghu-data:/data busybox:stable sh -c '
  cp /data/backups/control-20261027T140000Z.db /data/control.db.restoring &&
  rm -f /data/control.db-wal /data/control.db-shm &&
  mv /data/control.db.restoring /data/control.db'
docker compose -f deploy/compose.yaml start beghu
```

Running it as uid 65532 keeps the restored file owned by the user beghu runs as. A file left
owned by root can't be opened for writing, and beghu won't start.

The control DB is now as of the backup. Sign-ins and repo picks made since are gone: those
accounts sign in or pick again. If a token refresh happened since the backup, its account is asked to sign
in again. GitHub refresh tokens are single-use, and the backup holds the spent one. Webhooks
GitHub delivered since are caught up by redelivery, and anything redelivery can't reach is caught
up by sweeps. The mirrors stay as they are.

Losing both the control DB and its backups costs every account a sign-in and a re-import.

## Assets across a deploy

A tab still running the previous build loads its chunks from `/assets/*` until it next navigates.
Each start copies its build's assets onto the volume, skipping files already there with the same
bytes, records the build in `builds/`, and marks the build before it superseded. A build id
deployed again keeps the files it listed before, as well as its new ones. A build superseded more than 24 h
ago is pruned, along with every file no remaining build lists. Pruning runs at startup and when a
superseded build's day is up. Any unknown `/assets/*` path is a 404, never the shell. That's
about 1–2 MB per build.

## First-load size

The cold first load (the shell, the entry chunk and the stylesheet, compressed) is budgeted at
48 KB on the wire (`docs/research/first-load.md`). In v1 the budget isn't a blocker: the image
ships whatever the build produces. The perf gates (#117) will enforce it.
