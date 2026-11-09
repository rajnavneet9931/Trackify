# Build with the repository root as context:
# docker build -f apps/api/Dockerfile -t trackify-api .
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# Prisma postinstall needs schema/config available during npm ci.
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w @trackify/api
# Retain generated Prisma client, but remove build-only packages.
FROM build AS production-deps
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd --system app && useradd --system --gid app app
COPY --from=production-deps --chown=app:app /app/node_modules ./node_modules
# Preserve workspace-local dependencies (including cookie 2.x) at runtime.
COPY --from=production-deps --chown=app:app /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/package.json
USER app
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

# Optional image for a one-off ECS migration task (contains Prisma CLI).
FROM build AS migration
WORKDIR /app/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]
