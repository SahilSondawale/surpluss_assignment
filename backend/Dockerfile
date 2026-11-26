# One image for the API, the workers and the migration step.
# docker-compose.yml chooses what to run with `command`.

# ---- Stage 1: install all dependencies and compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev

# ---- Stage 2: only compiled code + production dependencies ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
