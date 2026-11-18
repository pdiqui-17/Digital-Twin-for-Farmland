# Multi-stage Dockerfile cho @digital-twin/processor (chạy từ thư mục gốc monorepo)
# Build: docker build -f services/processor/Dockerfile -t dtf-processor:latest .

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY services/processor/package.json services/processor/tsconfig.json ./services/processor/

RUN npm ci --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/processor

COPY packages/shared/src ./packages/shared/src
COPY services/processor/src ./services/processor/src

RUN npm run build --workspace=@digital-twin/shared && npm run build --workspace=@digital-twin/processor

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/processor/package.json ./services/processor/

RUN npm ci --omit=dev --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/processor

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/processor/dist ./services/processor/dist

USER node
EXPOSE 3002
CMD ["node", "services/processor/dist/index.js"]
