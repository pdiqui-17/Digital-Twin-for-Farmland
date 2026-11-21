# Digital Twin cho Farmland

Monorepo npm workspaces. Phân công: `docs/project_assigning.md`.

| Role | Service | Tài liệu |
|---|---|---|
| A: Data & Pipeline | `services/simulator` (3001), `services/processor` (3002), `db/` | `docs/role-a-technical-guide.md`, `docs/role-a-handover-and-contracts.md` |
| B: Twin Core | `services/twin-service` (3010), `services/controller` (3011), `services/analytics` (3012) | `docs/api.md`, `docs/role-b-plan.md` |
| Chung | `packages/shared` (`@digital-twin/shared`) | |

```bash
npm install
cp .env.example .env     # rồi đặt mật khẩu Postgres/MinIO
npm test                 # toàn bộ test
npm run typecheck
npm run eval             # MAE/RMSE mô hình dự đoán của Analytics
```

Chạy toàn hệ thống và kiểm thử vòng tưới: `docs/api.md`, mục 4.
