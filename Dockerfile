# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.19.0
ARG NGINX_VERSION=1.28-alpine

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /workspace

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates g++ make openssl python3 \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json tspconfig.yaml vitest.config.ts ./
COPY prisma.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY spec ./spec
COPY deploy ./deploy

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    corepack pnpm install --frozen-lockfile
RUN corepack pnpm build
RUN corepack pnpm web:build

FROM node:${NODE_VERSION}-bookworm-slim AS api
WORKDIR /app

ENV NODE_ENV=production \
    ADMINBOT_REIMBURSEMENT_PYTHON=/opt/adminbot-reimbursements/bin/python

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates openssl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY packages/reimbursements/requirements.txt /tmp/reimbursement-requirements.txt
RUN python3 -m venv /opt/adminbot-reimbursements \
    && /opt/adminbot-reimbursements/bin/pip install --no-cache-dir \
      --requirement /tmp/reimbursement-requirements.txt \
    && rm /tmp/reimbursement-requirements.txt

COPY --from=build --chown=node:node /workspace /app
RUN mkdir -p /app/state && chown node:node /app/state

USER node
VOLUME ["/app/state"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/v0alpha/session').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["sh", "/app/deploy/docker/api-entrypoint.sh"]

FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS web
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:8080/healthz"]
