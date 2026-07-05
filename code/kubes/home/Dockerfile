# --- backend build -------------------------------------------------------
FROM node:24-alpine AS backend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# --- frontend build ------------------------------------------------------
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
# git: the shared layout harness is a git dependency (github:xinutec/ui-harness),
# so npm ci clones it — node:alpine ships no git.
RUN apk add --no-cache git ca-certificates && npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime -------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /app/frontend/dist/frontend/browser ./public
# The node base image ships a nonroot "node" user (uid 1000), matched by
# k8s/03-app.yaml. Files above are world-readable, so it can run them.
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
