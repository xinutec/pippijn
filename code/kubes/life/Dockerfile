# Multi-stage build for the life app: Angular frontend + Rust backend, served
# from one image (the backend serves the bundle + API). Mirrors the fleet's
# image convention (xinutec/<app>:latest).

# --- frontend: build the Angular bundle ---
FROM node:24-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
# git: the shared layout harness is a git dependency (github:xinutec/ui-harness),
# so npm ci clones it — node:alpine ships no git.
RUN apk add --no-cache git ca-certificates && npm ci
COPY frontend/ .
# Stamp the build version into the bundle (see scripts/stamp-version.mjs). The
# build context has no .git, so the commit comes from GIT_SHA (passed by CI —
# .github/workflows/docker.yml); it defaults to 'dev' for a plain local build.
ARG GIT_SHA=dev
RUN GIT_SHA="$GIT_SHA" node scripts/stamp-version.mjs
RUN npx ng build --configuration production

# --- backend: build the Rust binary (deps cached in their own layer) ---
FROM rust:1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Prime the dependency cache with a stub crate, then build for real.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && echo '' > src/lib.rs \
    && cargo build --release && rm -rf src
COPY src/ src/
COPY migrations/ migrations/
RUN touch src/main.rs src/lib.rs && cargo build --release

# --- runtime ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# The app only reads (binary, bundle, scenes) and never writes to disk, so
# everything stays root-owned; the process just must not run as root. uid/gid
# 65532 is the conventional "nonroot" id, matched by k8s/03-app.yaml.
RUN groupadd --gid 65532 life \
    && useradd --uid 65532 --gid life --no-create-home --shell /usr/sbin/nologin life
WORKDIR /app
COPY --from=backend /app/target/release/life /usr/local/bin/life
COPY --from=frontend /fe/dist/life-web/browser ./public
COPY scenes/ ./scenes
ENV STATIC_DIR=/app/public \
    HOUSE_SCENE=/app/scenes/house.json \
    BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
USER life
CMD ["life"]
