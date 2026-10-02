# One image for api and worker (ARCHITECTURE: deployment); pick the start command per service:
#   api:    pnpm --filter @tappay/api start
#   worker: pnpm --filter @tappay/worker start
# Run migrations as a release step: pnpm db:migrate
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production TZ=Africa/Johannesburg
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod=false --filter "!@tappay/web"
COPY . .
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@tappay/api", "start"]
