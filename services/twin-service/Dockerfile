# Multi-stage Dockerfile cho @digital-twin/twin-service (chạy từ thư mục gốc monorepo, cùng mẫu với simulator/processor)
# Build: docker build -f services/twin-service/Dockerfile -t dtf-twin-service:latest .
# Cấu hình hoàn toàn qua biến môi trường (image không chứa .env); danh sách biến: docs/api.md

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY services/twin-service/package.json services/twin-service/tsconfig.json services/twin-service/tsconfig.build.json ./services/twin-service/

RUN npm ci --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/twin-service

COPY packages/shared/src ./packages/shared/src
COPY services/twin-service/src ./services/twin-service/src

RUN npm run build --workspace=@digital-twin/shared && npm run build --workspace=@digital-twin/twin-service

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/twin-service/package.json ./services/twin-service/

RUN npm ci --omit=dev --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/twin-service

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/twin-service/dist ./services/twin-service/dist

USER node
EXPOSE 3010
CMD ["node", "services/twin-service/dist/index.js"]
