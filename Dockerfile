# beghu's image: one process serving plain HTTP on PORT, with every byte of state on the volume
# at /data. docs/deploy.md is the recipe around it (environment, volume, edge, stop grace period).
#
#   docker build --build-arg BEGHU_BUILD_ID="$(git rev-parse HEAD)" -t beghu:"$(git rev-parse HEAD)" .
#
# BEGHU_BUILD_ID is required: the build fails without it.
#
# The stages: the web app (vite build, with its .br/.gz siblings and the Vite manifest the server
# reads at startup); a glibc release build of the server, its dependencies first in a layer of
# their own (cargo-chef); then distroless, running as nonroot. The base images are pinned by
# digest (their multi-arch index); bump a tag and its digest together
# (`skopeo inspect --raw docker://<image:tag> | sha256sum`).
#
# Caching: the server's dependencies are built from cargo-chef's recipe (the manifests and the
# lockfile, nothing else), so their layer is reused, locally and through CI's GitHub Actions
# cache, until a dependency changes; a source change rebuilds only beghu's own crates. npm's
# download cache is a BuildKit cache mount (local builds only; CI caches the layers).
#
# npm runs no package's install script (--ignore-scripts): the build's tools ship their platform
# binaries as optional dependencies (esbuild, Rollup), and the one package with a script is
# fsevents, macOS only. `npm audit signatures` then checks every package's registry signature and
# any provenance attestation against what the lockfile installed.

# 1. The web app. Its wire types (web/src/bindings) are committed, so no Rust is needed here.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund \
    && npm audit signatures
COPY web/ ./
RUN npx vite build

# 2. The server: glibc rather than musl, whose allocator is slow under multi-threaded tokio and
# SQLite. Bundled SQLite gets its pinned flags from .cargo/config.toml.
FROM rust:1-slim-bookworm@sha256:86234e857a413004348b471d11a4ebe1aa92d2eae2b6b143cac68fd1ac3c48be AS chef
RUN cargo install cargo-chef --locked --version 0.1.78
WORKDIR /src

# The dependency recipe: the workspace's manifests and lockfile, reduced to what the dependency
# build needs, so the layer below changes only when they do. The build id is checked here, early.
FROM chef AS planner
ARG BEGHU_BUILD_ID
RUN test -n "$BEGHU_BUILD_ID" || { echo "set --build-arg BEGHU_BUILD_ID (the git SHA)" >&2; exit 1; }
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS server
COPY --from=planner /src/recipe.json recipe.json
COPY .cargo .cargo
RUN cargo chef cook --release --locked -p beghu --recipe-path recipe.json
COPY . .
RUN cargo build --release --locked -p beghu \
    && install -D target/release/beghu /out/beghu \
    && install -d /out/data

# 3. What runs: the binary, the web build, and /data owned by nonroot (uid 65532), so a fresh
# named volume starts out writable. Debian 13 while the build stages are 12: the binary, linked
# against bookworm's glibc 2.36, runs on trixie's 2.41. cc-debian12 was still shipping libssl3
# 3.0.20 after Debian's 3.0.22 fixed CVE-2026-84782; beghu never loads libssl (it uses rustls),
# but deployers' image scans fail on it.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:cb87acc574abe719b6e5c547384defa2f7b1f24af9605d3f618cf852495d8be2
ARG BEGHU_BUILD_ID
# The source label links the ghcr.io package to this repo; the revision names the commit.
LABEL org.opencontainers.image.source=https://github.com/AdvanGrid/beghu \
    org.opencontainers.image.revision=${BEGHU_BUILD_ID}
ENV BEGHU_BUILD_ID=${BEGHU_BUILD_ID} \
    PORT=8080 \
    BEGHU_DATA_DIR=/data \
    BEGHU_WEB_DIR=/app/web
COPY --from=server /out/beghu /app/beghu
COPY --from=web /src/web/dist /app/web
COPY --from=server --chown=65532:65532 /out/data /data
VOLUME /data
EXPOSE 8080
USER nonroot
# The drain and its WAL checkpoint take up to 25 s: give the stop 30 s (docs/deploy.md,
# "Stopping"). Docker's default of 10 s cuts the drain short.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/beghu"]
