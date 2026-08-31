FROM node:20-alpine AS builder

WORKDIR /app

# node:20-alpine ships libssl.so.3 but not the `openssl` CLI binary itself. Prisma's
# platform-detection shells out to `openssl version` to resolve what "native" means for
# binaryTargets — without the CLI present it can't detect anything, falls back to a wrong
# guess ("openssl-1.1.x" despite libssl.so.3 = 3.x being present), and `prisma generate`
# fails outright: "Unknown binaryTarget native and no custom engine files were provided".
RUN apk add --no-cache openssl

# Prisma's CLI engine (schema-engine, used by `prisma migrate`) is resolved separately
# from @prisma/client's query-engine — schema.prisma's `binaryTargets` only governs the
# latter. Without this, @prisma/engines' own postinstall only caches a generic `linux-musl`
# schema-engine, and the openssl-3.0.x variant this runtime actually needs gets fetched
# over the network on first `migrate deploy` — fragile if that network path is ever down.
# This forces that one concrete variant to be cached here, at build time, instead.
# NOTE: "native" is deliberately NOT listed here — it isn't a real downloadable platform
# target for @prisma/engines' fetch mechanism (only schema.prisma's own generator block
# resolves "native" dynamically at generate-time); including it here broke `prisma
# generate` outright ("Unknown binaryTarget native and no custom engine files provided").
ENV PRISMA_CLI_BINARY_TARGETS=linux-musl-openssl-3.0.x

# Install all deps once (dev + prod)
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma
COPY --chmod=755 entrypoint.sh ./entrypoint.sh
COPY --chmod=755 migrate.sh ./migrate.sh
RUN npm ci --legacy-peer-deps

# Generate Prisma client with project-pinned version
RUN npx prisma generate

# Copy source and build
COPY src ./src
RUN npm run build; test -f dist/main.js

# ─────────────────────────────────────────────────────────────────────────────
# Production image (reusing node_modules из builder, чтобы не дёргать Prisma)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache openssl postgresql-client

# Копируем собранный код и зависимости (включая @prisma/client)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
COPY --from=builder /app/migrate.sh ./migrate.sh

EXPOSE 3000

# entrypoint.sh: exec node dist/main.js only — no migrations here.
# Migrations run once via the db-migrate compose service (migrate.sh), before
# api/api-worker start. See migrate.sh / docker-compose.yml's db-migrate service.
CMD ["/bin/sh", "entrypoint.sh"]
