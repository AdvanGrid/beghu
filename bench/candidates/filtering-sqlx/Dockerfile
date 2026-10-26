FROM docker.io/library/node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
COPY server/bindings /src/server/bindings
RUN npx vite build --outDir /out/public

FROM docker.io/library/rust:1-slim-bookworm AS server
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/.cargo ./.cargo
COPY server/src ./src
COPY server/migrations ./migrations
# sqlx's `query!` checks SQL against a live database at build time: an empty one built from the
# migrations, so the image needs no `.sqlx` offline data.
RUN apt-get update -qq && apt-get install -y -qq sqlite3 >/dev/null && cat migrations/*.sql | sqlite3 /src/schema.db
ENV DATABASE_URL=sqlite:///src/schema.db
# STOCK_SQLITE=1 builds with rusqlite's default SQLite flags instead of .cargo/config.toml's, for comparison.
ARG STOCK_SQLITE
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    if [ -n "$STOCK_SQLITE" ]; then export LIBSQLITE3_FLAGS=" "; fi && \
    cargo build --release && cp target/release/bench-filtering-sqlx /bench-axum-solid

FROM docker.io/library/debian:bookworm-slim
WORKDIR /app
COPY --from=server /bench-axum-solid /app/server
COPY --from=web /out/public /app/public
ENV PUBLIC_DIR=/app/public
EXPOSE 8080
CMD ["/app/server"]
