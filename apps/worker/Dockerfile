# Build from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @zachhub/worker... && pnpm --filter @zachhub/worker build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/apps/worker/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
