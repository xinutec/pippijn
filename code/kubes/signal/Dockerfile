# --- build ---------------------------------------------------------------
# Debian (glibc), not musl/alpine: presage's crypto deps build reliably on
# glibc and fight musl toolchains. Build deps: protobuf-compiler (libsignal's
# build.rs compiles its protobufs via prost-build → needs `protoc`) and perl
# (ring's asm build). gcc/cc ships in the rust image.
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        protobuf-compiler perl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml ./
# Cargo.lock is committed once the first build generates it; the glob keeps the
# build working before then.
COPY Cargo.lock* ./
COPY src ./src
RUN cargo build --release && cp target/release/signal-archiver /signal-archiver

# --- runtime -------------------------------------------------------------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /signal-archiver /usr/local/bin/signal-archiver
ENTRYPOINT ["signal-archiver"]
CMD ["run"]
