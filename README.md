# Digital Twin Farm - Role B (Twin Core)

Kế hoạch: `docs/role-b-plan.md`. API và cấu hình: `docs/api.md`.

```bash
npm install
npm test                 # toàn bộ test
npm run typecheck
npm run eval             # MAE/RMSE mô hình dự đoán (dữ liệu tổng hợp, hoặc: npm run eval -- data.csv)

# Chạy thử cục bộ không cần hạ tầng:
ENABLE_DEV_INGEST=1 npm start -w @farm/twin-service
WEATHER=constant   npm start -w @farm/analytics
TICK_SEC=2         npm start -w @farm/controller
npm run fake-feed -- --drought zone-B --interval 1
```
