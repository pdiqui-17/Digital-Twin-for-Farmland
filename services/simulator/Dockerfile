# Multi-stage Dockerfile cho @digital-twin/simulator (chạy từ thư mục gốc monorepo)
# Build: docker build -f services/simulator/Dockerfile -t dtf-simulator:latest .

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY services/simulator/package.json services/simulator/tsconfig.json ./services/simulator/

RUN npm ci --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/simulator

COPY packages/shared/src ./packages/shared/src
COPY services/simulator/src ./services/simulator/src

RUN npm run build --workspace=@digital-twin/shared && npm run build --workspace=@digital-twin/simulator

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY services/simulator/package.json ./services/simulator/

RUN npm ci --omit=dev --include-workspace-root --workspace=@digital-twin/shared --workspace=@digital-twin/simulator

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/services/simulator/dist ./services/simulator/dist

USER node
EXPOSE 3001
CMD ["node", "services/simulator/dist/index.js"]
