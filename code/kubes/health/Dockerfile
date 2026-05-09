FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist dist/
COPY --from=build /app/node_modules node_modules/
COPY package.json ./
CMD ["node", "dist/main.js"]
