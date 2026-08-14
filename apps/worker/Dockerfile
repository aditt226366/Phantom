# syntax=docker/dockerfile:1
#
# whatsapp-os background worker.
#
# Build from the REPOSITORY ROOT, not from this directory - the worker depends
# on packages/db and packages/core, which live outside apps/worker:
#
#     docker build -f apps/worker/Dockerfile -t whatsapp-os-worker .
#
# The worker runs TypeScript directly through tsx, so there is no compile step.
# Prisma 7 connects through a driver adapter rather than a bundled query
# engine, which means no native engine binary and no libc/openssl juggling on
# Alpine - `prisma generate` emits plain TypeScript.

# ---------------------------------------------------------------------------
# Stage 1 - install dependencies and generate the Prisma client
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/

# Drop apps/web from the workspace list before installing.
#
# `npm ci --workspace=worker` does NOT give a pruned tree - npm reproduces the
# entire lockfile regardless, which drags Next.js, React and lucide-react into
# a worker image that will never render a page (748MB of node_modules, 330MB
# of it web-only). `npm prune --omit=dev` cannot remove them either, because
# they are production dependencies *of the web workspace*.
#
# Narrowing the workspace array first is what actually scopes the install. The
# lockfile is still honoured, so the build stays reproducible.
RUN node -e "const p=require('./package.json'); p.workspaces=['apps/worker','packages/core','packages/db']; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2))" \
    && npm ci --no-audit --no-fund

# Only what `prisma generate` reads. Kept separate from application source so
# a code change does not invalidate the dependency layer.
COPY packages/db/prisma.config.ts ./packages/db/
COPY packages/db/prisma ./packages/db/prisma
RUN npm run generate --workspace=@whatsapp-os/db

# Drop build-only dependencies. tsx is a runtime dependency of the worker, so
# it survives; @prisma/client and @prisma/adapter-pg are runtime and stay.
#
# The explicit rm is not redundant with the prune: npm installs a workspace
# package's devDependencies even under --omit=dev, because workspaces are part
# of the project rather than external dependencies. So the Prisma CLI - which
# has finished its job at this point - survives a prune and has to go by hand.
# The rm must come LAST. `npm prune` runs a reify pass that repairs the tree
# against the lockfile, so any npm command after the rm puts these straight
# back.
RUN npm prune --omit=dev \
    && rm -rf node_modules/prisma \
              node_modules/typescript \
              node_modules/effect \
              node_modules/@electric-sql \
              node_modules/elkjs \
              node_modules/.bin/prisma \
              node_modules/.bin/tsc \
              node_modules/.bin/tsserver

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so the worker's graceful-shutdown
# handler actually runs on `docker stop` instead of being SIGKILLed.
RUN apk add --no-cache tini

# node_modules/@whatsapp-os/* are symlinks into packages/*, so the real
# directories have to be present for those links to resolve.
COPY --from=deps /app/node_modules ./node_modules

COPY package.json tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/db ./packages/db
COPY apps/worker ./apps/worker

# The generated client last, overlaying the source copy above: .dockerignore
# excludes **/src/generated from the build context, so it can only come from
# the deps stage.
COPY --from=deps /app/packages/db/src/generated ./packages/db/src/generated

# Drop privileges. The node image ships an unprivileged `node` user (uid 1000).
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "apps/worker/src/index.ts"]
