# Multi-stage build: Angular frontend + Rust backend in one image (the backend
# serves the bundle + API). Mirrors the fleet's xinutec/<app>:latest convention.

# --- frontend ---
FROM node:24-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npx ng build --configuration production

# --- backend (deps cached in their own layer) ---
FROM rust:1-bookworm AS backend
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && echo '' > src/lib.rs \
    && cargo build --release && rm -rf src
COPY src/ src/
RUN touch src/main.rs src/lib.rs && cargo build --release

# --- runtime ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/target/release/messages /usr/local/bin/messages
COPY --from=frontend /fe/dist/messages-web/browser ./public
ENV STATIC_DIR=/app/public \
    BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
CMD ["messages"]
