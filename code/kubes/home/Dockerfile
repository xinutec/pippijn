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
RUN npm ci
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
EXPOSE 3000
CMD ["node", "dist/server.js"]
