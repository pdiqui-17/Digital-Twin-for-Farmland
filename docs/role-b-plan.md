# Kế hoạch chi tiết Role B: Twin Core

Phạm vi: `services/twin-service`, `services/analytics`, `services/controller`, phần schema twin trong `packages/shared`.
Nguyên tắc: làm theo thứ tự phụ thuộc, mỗi bước có tiêu chí hoàn thành (DoD) kiểm tra được bằng test hoặc lệnh chạy.

## 0. Quyết định thiết kế (chốt trước khi code)

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Logic nghiệp vụ là hàm thuần trong `domain/`, I/O (Kafka, MQTT, Postgres) nằm ở `adapters`/`repositories` sau interface | Test được không cần hạ tầng; B không bị chặn khi A/C chưa xong |
| D2 | Mỗi service có repository in-memory và Postgres, chọn bằng biến môi trường | Chạy local và test nhanh; deploy thật dùng PG |
| D3 | `twin_state` mỗi zone = 1 dòng JSONB, chỉ Twin Service ghi | Đúng nguyên tắc một bảng một writer (mục 3.3 tài liệu gốc) |
| D4 | Chỉ nhận reading mới hơn `lastTs` của sensor đó; reading trùng/cũ bị bỏ qua | Idempotent khi Kafka giao lại, chịu out-of-order |
| D5 | Zone quá `STALE_AFTER_SEC` không có dữ liệu thì `status = unknown` | Twin không giả vờ biết điều nó không biết |
| D6 | Cảnh báo: Twin Service/Controller chỉ publish topic `alerts`; một module `AlertStore` duy nhất ghi bảng `alerts` (trong Controller) | Sửa mâu thuẫn mục 3.3: một bảng một writer |
| D7 | Cảnh báo có hysteresis (ngưỡng vào ≠ ngưỡng ra) và cooldown, có vòng đời open/closed | Tránh spam Telegram khi giá trị dao động quanh ngưỡng |
| D8 | Van là máy trạng thái `idle → pending → watering → cooldown`; zone `unknown` thì không tự tưới | An toàn khi mất dữ liệu |
| D9 | Mô hình Analytics là cân bằng nước tuyến tính 3 hệ số (bay hơi, hiệu quả tưới, hiệu quả mưa), fit bằng bình phương tối thiểu; KHÔNG dùng công thức của simulator | Tránh sai số đẹp giả tạo |
| D10 | Đánh giá bằng chia train/test theo thời gian, so MAE/RMSE với baseline persistence và linear-trend | Số liệu cho báo cáo mục 5.4 |

## 1. Hợp đồng dữ liệu (tuần 1)

- B1.1 `packages/shared`: zod schema + type cho `Reading`, `ZoneState`, `Alert`, `Command`, `ValveState`; hằng số topic MQTT/Kafka và hàm dựng topic. **DoD:** `npm test -w @farm/shared` pass; schema parse đúng ví dụ mục 3.4.
- B1.2 Danh sách chỉ số cần Processor chuẩn hóa: `soil_moisture` (%), `soil_temp` (°C), `air_temp` (°C), `air_humidity` (%), `rain` (mm/h), `leaf_wetness` (tùy chọn). **DoD:** ghi trong `docs/api.md`, gửi A.
- B1.3 `docs/api.md`: API Twin Service, Controller, Analytics. **DoD:** cả nhóm duyệt.
- B1.4 `db/migrations/010_twin.sql`: DDL `twin_state`, `commands`, `alerts` (đề xuất cho A merge). **DoD:** file SQL chạy được trên Timescale/Postgres.
- B1.5 `scripts/fake-feed.ts`: sinh reading giả theo schema để B không phụ thuộc A. **DoD:** chạy lệnh thấy Twin Service cập nhật.

## 2. Twin Service (tuần 2-3)

- B2.1 `domain/derived.ts`: stress nước (0-1) từ độ ẩm đất với ngưỡng héo WP và sức chứa FC; nguy cơ nấm (0-1) từ độ ẩm không khí và nhiệt độ kéo dài. **DoD:** test bảng giá trị biên.
- B2.2 `domain/twin.ts`: `applyReading(state, reading, now)` thuần: kiểm tra D4, cập nhật sensor, tính lại derived, tính `status`. `markStale(state, now)` theo D5. **DoD:** test trùng, cũ, mất tín hiệu, quality=bad.
- B2.3 `repositories`: interface `TwinRepository` + `InMemoryTwinRepository` + `PgTwinRepository` (upsert JSONB). **DoD:** test in-memory; PG kiểm tra bằng SQL ở B1.4.
- B2.4 `ingest`: consumer Kafka `telemetry.clean` (kafkajs) gọi `applyReading`; chế độ `INGEST=poll` đọc trực tiếp `sensor_readings` khi Kafka chưa sẵn sàng. **DoD:** chạy với fake-feed ở chế độ memory.
- B2.5 REST: `GET /zones`, `GET /zones/:id`, `GET /zones/:id/history?metric&from&to&limit`, `/healthz`, `/readyz`, `/metrics`. **DoD:** test HTTP.
- B2.6 SSE `GET /stream` đẩy cập nhật zone. **DoD:** test nhận event sau khi apply reading.
- B2.7 Metrics Prometheus: `twin_readings_applied_total`, `twin_readings_dropped_total{reason}`, `twin_zone_status{zone,status}`, `twin_ingest_lag_seconds`. **DoD:** `/metrics` có các series.
- B2.8 Dashboard Grafana: JSON provisioning 4 zone (moisture, stress, status). **DoD:** file JSON hợp lệ, import được.

## 3. Cảnh báo và Controller (tuần 4-5)

- B3.1 `domain/alerts.ts`: `evaluateAlerts(prevOpen, zoneState, rules, now)` trả về danh sách mở/đóng, hysteresis + cooldown (D7). **DoD:** test dao động quanh ngưỡng chỉ sinh 1 cảnh báo.
- B3.2 `adapters/notifier.ts`: Telegram + log (interface `Notifier`). **DoD:** test với notifier giả.
- B3.3 `domain/valve.ts`: máy trạng thái (D8) với `decide(zoneState, valveCtx, rules, now)` trả `Command | null` và `transition(ctx, event)`. Có `maxRunSec`, `minRestSec`, `ackTimeoutSec`, `commandId`. **DoD:** test: không tưới liên tục, không tưới khi unknown, timeout ack, dừng khi đạt ngưỡng.
- B3.4 `adapters/mqtt.ts`: publish `cmd`, subscribe `state`. **DoD:** chạy qua broker giả (interface).
- B3.5 `CommandStore` + `AlertStore` (memory/PG) theo D6. **DoD:** test ghi lệnh kèm lý do.
- B3.6 Vòng lặp Controller `tick()`: đọc twin (HTTP hoặc repo), quyết định, gửi lệnh, đánh giá cảnh báo. **DoD:** test closed loop với simulator mini: hạn hán -> cảnh báo -> tưới -> độ ẩm phục hồi -> đóng cảnh báo. (MVP M2)

## 4. Analytics (tuần 6-7)

- B4.1 `domain/waterBalance.ts`: `step(m, params, inputs)`; `simulate(m0, params, inputs[])`. **DoD:** test bảo toàn khi hệ số 0.
- B4.2 `domain/calibrate.ts`: fit hệ số bằng bình phương tối thiểu (normal equations) trên chuỗi lịch sử; ràng buộc hệ số không âm. **DoD:** test khôi phục hệ số từ dữ liệu tổng hợp có nhiễu.
- B4.3 `domain/forecast.ts`: dự đoán 1h/3h/6h dùng dự báo thời tiết (interface `WeatherProvider`, adapter Open-Meteo có cache). **DoD:** test với provider giả.
- B4.4 `domain/whatif.ts`: so sánh nhiều lịch tưới, trả quỹ đạo và chỉ số (độ ẩm min, thời gian dưới WP, tổng nước). **DoD:** test lịch tưới nhiều hơn cho độ ẩm cao hơn.
- B4.5 `domain/evaluate.ts`: MAE/RMSE, baseline persistence và linear-trend, chia train/test theo thời gian. **DoD:** script `npm run eval -w analytics` in bảng.
- B4.6 REST: `POST /forecast`, `POST /whatif`, `GET /model`. **DoD:** test HTTP.

## 5. Đóng gói và tích hợp (xuyên suốt)

- B5.1 Dockerfile multi-stage cho 3 service (giao C). **DoD:** `docker build` pass (không chạy được trong sandbox, ghi rõ).
- B5.2 Danh sách biến môi trường từng service trong `docs/api.md` (C cần).
- B5.3 Cuối mỗi mốc chạy `npm test` toàn repo và `scripts/e2e-local.ts`. **DoD:** xanh.

## 6. Thứ tự thực hiện trong phiên làm việc này

1. Workspace + shared (B1.1-1.5)
2. Twin Service domain + API (B2.1-2.7)
3. Alerts + Controller (B3.1-3.6)
4. Analytics (B4.1-4.6)
5. Dashboard JSON, Dockerfile, tài liệu, chạy toàn bộ test

## 7. Rủi ro và cách giảm

| Rủi ro | Giảm |
|---|---|
| A trễ dữ liệu | fake-feed + chế độ poll |
| Không có hạ tầng thật để test | Mọi I/O sau interface, test bằng bản memory |
| Mô hình dự đoán kém | Vẫn báo cáo so baseline; ghi giới hạn |
| Tưới lặp | D8 + test bắt buộc |
