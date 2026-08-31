FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install deps from monorepo root (no lockfile — use npm install)
FROM base AS deps
COPY package.json ./
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --workspace=apps/web --include-workspace-root --legacy-peer-deps

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_API_URL=https://api.evpulse.app
ARG NEXT_PUBLIC_WS_URL=wss://api.evpulse.app
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app/apps/web
RUN npm run build

# Production runner
# With outputFileTracingRoot=monorepo-root, standalone puts server.js at apps/web/server.js
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# sharp (Next.js image optimiser) needs these native libs on Alpine
RUN apk add --no-cache libc6-compat vips-dev

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output (includes node_modules traced from monorepo root)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./

# Copy public assets to where server.js expects them
COPY --from=builder /app/apps/web/public ./apps/web/public

# Copy static files to where server.js expects them (relative to its location)
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# server.js is at apps/web/server.js within the standalone output
CMD ["node", "apps/web/server.js"]
