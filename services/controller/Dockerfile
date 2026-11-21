# Multi-stage Dockerfile cho @digital-twin/controller (chạy từ thư mục gốc monorepo, cùng mẫu với simulator/processor)
# Build: docker build -f services/controller/Dockerfile -t dtf-controller:latest .
# Cấu hình hoàn toàn qua biến môi trường (image không chứa .env); danh sách biến: docs/api.md

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY services/controller/package.json services/controller/tsconfig.json services/controller/tsconfig.build.json ./services/controller/

RUN npm ci --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/controller

COPY packages/shared/src ./packages/shared/src
COPY services/controller/src ./services/controller/src

RUN npm run build --workspace=@digital-twin/shared && npm run build --workspace=@digital-twin/controller

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/controller/package.json ./services/controller/

RUN npm ci --omit=dev --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/controller

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/controller/dist ./services/controller/dist

USER node
EXPOSE 3011
CMD ["node", "services/controller/dist/index.js"]
