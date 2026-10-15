FROM docker.io/library/rust:1-bookworm AS build
RUN rustup target add wasm32-unknown-unknown \
 && curl -fsSL https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.11/cargo-leptos-x86_64-unknown-linux-musl.tar.gz \
  | tar xz -C /usr/local/cargo/bin --strip-components=1 cargo-leptos-x86_64-unknown-linux-musl/cargo-leptos
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    --mount=type=cache,target=/root/.cache \
    cargo leptos build --release --precompress \
 && mkdir /out && cp target/release/bench-leptos /out/ && cp -r target/site /out/site

FROM docker.io/library/debian:bookworm-slim
WORKDIR /app
COPY --from=build /out /app
ENV LEPTOS_OUTPUT_NAME=bench-leptos LEPTOS_SITE_ROOT=site LEPTOS_SITE_PKG_DIR=pkg LEPTOS_ENV=PROD
EXPOSE 8080
CMD ["/app/bench-leptos"]
