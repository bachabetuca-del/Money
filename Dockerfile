FROM node:24-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10 --activate

COPY . .

RUN pnpm install --frozen-lockfile

ARG CLERK_PUBLISHABLE
ENV BASE_PATH=/

RUN test -n "$CLERK_PUBLISHABLE" \
  && pnpm --filter @workspace/api-server run build \
  && VITE_CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE" \
    pnpm --filter @workspace/kalshi-sports-alerts run build

ENV NODE_ENV=production
ENV PORT=8080
ENV SERVE_WEB=true
ENV BOT_WORKERS_ENABLED=false

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
