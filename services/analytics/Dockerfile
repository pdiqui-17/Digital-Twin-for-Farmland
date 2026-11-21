# Multi-stage Dockerfile cho @digital-twin/analytics (chạy từ thư mục gốc monorepo, cùng mẫu với simulator/processor)
# Build: docker build -f services/analytics/Dockerfile -t dtf-analytics:latest .
# Cấu hình hoàn toàn qua biến môi trường (image không chứa .env); danh sách biến: docs/api.md

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY services/analytics/package.json services/analytics/tsconfig.json services/analytics/tsconfig.build.json ./services/analytics/

RUN npm ci --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/analytics

COPY packages/shared/src ./packages/shared/src
COPY services/analytics/src ./services/analytics/src

RUN npm run build --workspace=@digital-twin/shared && npm run build --workspace=@digital-twin/analytics

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/analytics/package.json ./services/analytics/

RUN npm ci --omit=dev --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/analytics

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/analytics/dist ./services/analytics/dist

# Hệ số đã calibrate theo zone; gắn volume vào /data để giữ qua lần khởi động lại
ENV ANALYTICS_MODEL_FILE=/data/analytics-model.json
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3012
CMD ["node", "services/analytics/dist/index.js"]
