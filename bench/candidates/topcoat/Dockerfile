# syntax=docker/dockerfile:1
FROM docker.io/library/rust:1-trixie AS build
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install topcoat-cli --version 0.10.0 --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src src
# The asset bundle (the runtime script, app.css) is written next to the binary.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    topcoat asset bundle --release && \
    mkdir /out && cp target/release/bench-topcoat /out/ && cp -r target/release/assets /out/assets

FROM docker.io/library/debian:trixie-slim
COPY --from=build /out /app
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/bench-topcoat"]
