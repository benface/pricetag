# The hosted server: the API only, with invites, limits and redacted logs (PRICETAG_HOSTED=1). See "Hosting" in docs/OPERATIONS.md.
# Pinned by digest, like every other dependency here.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

WORKDIR /app
ENV NODE_ENV=production PRICETAG_HOSTED=1 PORT=8080
# The same pnpm as the lockfile, and nothing runs at install time.
RUN npm install --global --ignore-scripts pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY packages/sdk/src packages/sdk/src
COPY server server
COPY src/core src/core

USER node
EXPOSE 8080
# Set rather than left to Node's guess from the machine's memory, because how much wallet history the server takes on comes from it.
# Memory outside the heap adds about 320 MB at the worst measured, so this keeps it under fly.toml's 1 GB (WORK-570).
CMD ["node", "--max-old-space-size=512", "server/index.ts"]
