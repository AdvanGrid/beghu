FROM docker.io/library/rust:1-slim-bookworm AS server
# The Proa CLI runs the linked RSJS build (a descriptor compile, then the final one).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/cli-target \
    cargo install proa-cli --version 0.1.3 --locked --root /opt/proa --target-dir /cli-target
WORKDIR /src
COPY app/Cargo.toml app/Cargo.lock ./
COPY app/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    /opt/proa/bin/proa build --no-check --no-assets --locked --artifact-out /bench-proa

FROM docker.io/library/debian:bookworm-slim
WORKDIR /app
COPY --from=server /bench-proa /app/server
COPY app/public /app/public
ENV PUBLIC_DIR=/app/public
EXPOSE 8080
CMD ["/app/server"]
