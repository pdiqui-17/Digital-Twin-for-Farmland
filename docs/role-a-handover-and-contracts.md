# Tổng kết Công việc Role A & Hợp đồng Tích hợp cho Role B, Role C

Tài liệu này tóm tắt toàn bộ các hạng mục **Role A (Data & Pipeline)** đã hoàn thành và ghi nhận chi tiết **các hợp đồng dữ liệu, tên topic, cấu trúc bảng CSDL, mã định danh thiết bị và metrics** đã chốt để **Role B (Twin Core)** và **Role C (Cloud & Platform)** triển khai đồng bộ, tránh lệch giao thức.

---

## 1. Tóm tắt những phần việc Role A đã hoàn thành

1. **Khung Monorepo & Gói hợp đồng chung (`packages/shared`):**
   - Cấu hình `npm workspaces`, `tsconfig.base.json`, chuẩn hóa schema `zod` + TypeScript types, bộ tạo/tách topic MQTT & Kafka, bộ chuẩn hóa đơn vị đo, structured logger và Express router dựng sẵn `/healthz`, `/readyz`, `/metrics`.
2. **Thiết kế CSDL đa tầng & Dữ liệu khởi tạo (`db/`):**
   - 4 bản SQL migrations tạo đầy đủ bảng danh mục (`farms`, `zones`, `sensors`, `actuators`), bảng chuỗi thời gian **TimescaleDB Hypertable** (`sensor_readings` kèm nén cột sau 7 ngày & tự xóa sau 30 ngày), **Continuous Aggregate** theo giờ (`sensor_readings_hourly` lưu giữ 365 ngày) và khung bảng nghiệp vụ (`twin_state`, `commands`, `alerts`).
   - Dữ liệu seed idempotent khởi tạo nông trại mẫu `farm-01`, 4 phân khu (`zone-A`..`zone-D`), 16 cảm biến cơ sở và 4 van tưới.
3. **Bộ mô phỏng nông trại & Van tưới ảo (`services/simulator`):**
   - Mô hình cân bằng nước đất 2 tầng phi tuyến (tầng mặt ↔ tầng rễ + thoát nước trọng lực) với đặc tính thủy lực riêng cho đất thịt (`loam`), đất cát (`sandy`), đất sét (`clay`); tích hợp thời tiết lịch sử thực tế từ **Open-Meteo** (có fallback nội bộ khi offline).
   - Hỗ trợ nhân bản **500+ cảm biến ảo**, cộng nhiễu Gaussian, kịch bản hạn hán, tiêm lỗi cảm biến (`out_of_range`, `stuck`, `dropout`, `drift`) và **van tưới ảo 2 chiều qua MQTT** (tự động tăng độ ẩm đất khi mở van và tự đóng khi hết `durationSec`).
4. **Pipeline thu thập, làm sạch & lưu trữ (`services/processor`):**
   - Thu nhận MQTT bằng **MQTT v5 Shared Subscription** (an toàn khi scale nhiều replica trên K8s) → đẩy vào Kafka `telemetry.raw`.
   - Lưu trữ lạnh gói tin gốc thành file `.ndjson` trên **MinIO** (`telemetry-raw`).
   - Kiểm định `zod`, quy đổi mọi đơn vị về chuẩn, lọc nhiễu EMA, gắn cờ chất lượng `quality`, phát sang Kafka `telemetry.clean` và ghi theo lô (batch insert idempotent) vào **TimescaleDB**.

---

## 2. Dữ liệu Danh mục Chuẩn đã chốt trong DB (`db/seed`)

Role B và Grafana có thể dựa trực tiếp vào các mã định danh cố định sau:

- **Farm ID:** `farm-01` (*GreenValley Digital Twin Farm - Lam Dong*, tọa độ `11.9404, 108.4583`, diện tích `4.0 ha`).

| Zone ID | Cây trồng (`crop_type`) | Loại đất (`soil_type`) | Ngưỡng ẩm tối ưu (%) | Van tưới (`actuator_id`) | Đặc tính vật lý phục vụ Demo |
|---|---|---|---|---|---|
| `zone-A` | `tomato` | `loam` | `45.0` – `70.0` | `valve-zone-A` (25 L/p) | Đất thịt nhà màng, cân bằng |
| `zone-B` | `lettuce` | `sandy` | `55.0` – `80.0` | `valve-zone-B` (30 L/p) | Đất cát thoát nước nhanh — **nhạy cảm hạn hán nhất** |
| `zone-C` | `bell_pepper` | `loam` | `40.0` – `65.0` | `valve-zone-C` (25 L/p) | Đất thịt ngoài trời |
| `zone-D` | `strawberry` | `clay` | `50.0` – `75.0` | `valve-zone-D` (20 L/p) | Đất sét giữ nước lâu — **dễ tăng nguy cơ nấm khi ẩm cao** |

- **4 loại cảm biến chuẩn (`SensorType`) & đơn vị chuẩn (`CanonicalUnit`) sau khi qua Processor:**
  1. `soil_moisture` → đơn vị chuẩn: `"percent"` (miền hợp lệ: `0` – `100`)
  2. `air_temperature` → đơn vị chuẩn: `"celsius"` (miền hợp lệ: `-10` – `60`)
  3. `air_humidity` → đơn vị chuẩn: `"percent"` (miền hợp lệ: `0` – `100`)
  4. `light_intensity` → đơn vị chuẩn: `"lux"` (miền hợp lệ: `0` – `150000`)
- **Mã 16 cảm biến gốc:** `s-{A|B|C|D}-{moisture|temp|humidity|light}` (ví dụ: `s-A-moisture`, `s-B-temp`, `s-D-humidity`, `s-D-light`). Khi bật chế độ Load Test, các cảm biến ảo bổ sung có dạng `s-{A|B|C|D}-v001`, `v002`...

---

## 3. Hợp đồng Giao tiếp cho Role B (Twin Core)

> **Khuyến nghị cho Role B:** Import trực tiếp các hằng số và Zod schema từ gói `@digital-twin/shared` (`MQTT_TOPICS`, `KAFKA_TOPICS`, `CleanTelemetryMessageSchema`, `ValveCommandMessageSchema`, `ValveStateMessageSchema`, `AlertEventSchema`, `createObservabilityRouter`, `createLogger`) thay vì viết lại chuỗi thủ công.

### 3.1. Đầu vào dữ liệu sạch cho Twin Service & Analytics — Kafka topic `telemetry.clean`

`processor` đã chuẩn hóa hết đơn vị (không còn `°F` hay `klux`) và đẩy JSON theo `CleanTelemetryMessageSchema` lên Kafka topic **`telemetry.clean`** (partition key = `zoneId`):

```json
{
  "farmId": "farm-01",
  "zoneId": "zone-B",
  "sensorId": "s-B-moisture",
  "type": "soil_moisture",
  "value": 52.4,
  "rawValue": 72.1,
  "unit": "percent",
  "ts": "2026-05-10T08:00:05.000Z",
  "ingestedAt": "2026-05-10T08:00:05.042Z",
  "quality": "ok"
}
```
*(Trường `rawValue` chỉ xuất hiện khi giá trị gốc đã được quy đổi đơn vị hoặc làm mượt nhiễu).*

**Cách Role B xử lý trường `quality`:**
| Giá trị `quality` | Ý nghĩa | Gợi ý hành xử cho Role B |
|---|---|---|
| `"ok"` | Dữ liệu sạch bình thường | Dùng cập nhật `twin_state` & chạy dự đoán Analytics |
| `"noisy_smoothed"` | Có gai nhiễu đột biến nhẹ nhưng đã được lọc mượt EMA | Dùng cập nhật `twin_state` bình thường |
| `"out_of_range"` | Cảm biến báo giá trị phi vật lý (vd `-14%`, `135%`) | **Không** ghi đè vào độ ẩm hiện tại của Twin; phát cảnh báo `category: "sensor_fault"` |
| `"stuck"` | Cảm biến kẹt cứng một con số liên tiếp nhiều chu kỳ | Phát cảnh báo `category: "sensor_fault"` |
| `"missing_signal"` | Cảm biến đứt kết nối quá ngưỡng thời gian chờ (20s) | Đánh dấu thiết bị offline trên Twin; phát cảnh báo `category: "sensor_fault"` |

### 3.2. Hợp đồng Điều khiển Van tưới (Closed-loop) qua MQTT

1. **Controller (Role B) gửi lệnh tưới** bằng cách publish JSON (`ValveCommandMessageSchema`) lên MQTT topic:
   `farm/{farmId}/zone/{zoneId}/actuator/valve/cmd` *(dùng hàm `MQTT_TOPICS.valveCommand(farmId, zoneId)`)*:
   ```json
   {
     "commandId": "cmd-20260510-001",
     "farmId": "farm-01",
     "zoneId": "zone-B",
     "actuatorId": "valve-zone-B",
     "action": "open",
     "durationSec": 60,
     "reason": "soil_moisture_below_optimal",
     "issuedBy": "controller",
     "ts": "2026-05-10T08:01:00.000Z"
   }
   ```
   - Nếu truyền `durationSec`, Simulator sẽ mở van làm tăng độ ẩm đất của `zone-B`, và **tự động đóng van** sau khi hết `durationSec` giây!
2. **Simulator (Role A) phản hồi trạng thái van** (QoS 1, `retain: true`) lên MQTT topic:
   `farm/{farmId}/zone/{zoneId}/actuator/valve/state` *(dùng `MQTT_TOPICS.valveStateWildcard(farmId)` để lắng nghe)*:
   ```json
   {
     "farmId": "farm-01",
     "zoneId": "zone-B",
     "actuatorId": "valve-zone-B",
     "state": "open",
     "lastCommandId": "cmd-20260510-001",
     "flowRateLitersPerMin": 30,
     "ts": "2026-05-10T08:01:00.015Z"
   }
   ```
   *(Khi tự động đóng sau `durationSec`, Simulator cũng phát lại một bản tin `state: "closed"` lên topic này để Controller và Twin cập nhật trạng thái).*

### 3.3. Lưu ý về Mô hình dự đoán Analytics của Role B
- Theo yêu cầu đề bài (mục 5.1): Simulator của Role A sử dụng **mô hình vật lý 2 tầng đất phi tuyến + thoát nước trọng lực + công thức bốc hơi kiểu Penman**. Role B vui lòng tự xây dựng mô hình cân bằng nước xấp xỉ tuyến tính đơn giản (`M(t+1) = M(t) - E + I + R`) hiệu chỉnh từ bảng lịch sử `sensor_readings` — không copy hàm từ `farmEngine.ts` để đảm bảo đánh giá sai số MAE/RMSE trung thực.

---

## 4. Hợp đồng Cơ sở dữ liệu & Phân quyền Ghi (`db/migrations`)

Toàn bộ các bảng đã được tạo sẵn trong `db/migrations/001` → `004`. Tuân thủ nghiêm ngặt nguyên tắc **mỗi bảng chỉ một thành phần ghi**:

| Tên bảng / View | Loại | Đơn vị được GHI | Đơn vị được ĐỌC | Ghi chú cấu trúc |
|---|---|---|---|---|
| `farms`, `zones`, `sensors`, `actuators` | Table | `db/seed` (A) | Tất cả | Đã có sẵn dữ liệu mẫu sau khi chạy `npm run db:setup` |
| `sensor_readings` | **Hypertable** | `processor` (A) | Twin, Analytics, Grafana | Cột: `ts, ingested_at, farm_id, zone_id, sensor_id, sensor_type, value, raw_value, unit, quality` |
| `sensor_readings_hourly` | **Continuous Aggregate** | Timescale tự động | Analytics, Grafana | Cột: `bucket, farm_id, zone_id, sensor_type, avg_value, min_value, max_value, sample_count` |
| `twin_state` | Table | `twin-service` (B) | Controller, Analytics, Grafana | Cột: `zone_id (PK), farm_id, state (JSONB), water_stress_index, fungal_risk_index, updated_at` |
| `commands` | Table | `controller` (B) | Twin, Grafana | Cột: `command_id (PK), farm_id, zone_id, actuator_id, action, duration_sec, reason, issued_by, status, ts, acknowledged_at` |
| `alerts` | Table | `twin-service`, `controller` (B) | Grafana | Cột: `alert_id (PK), farm_id, zone_id, severity, category, message, metadata (JSONB), acknowledged, ts` |

*(Nếu Role B cần thêm cột phụ vào 3 bảng `twin_state`, `commands`, `alerts`, hãy tạo migration tiếp theo `005_*.sql` và báo cho cả nhóm).*

---

## 5. Hợp đồng Hạ tầng & Giám sát cho Role C (Cloud & Platform)

1. **Containerization & Kubernetes Probes:**
   - Đã có sẵn multi-stage Dockerfile tối ưu (`node:22-alpine`, chạy dưới non-root `USER node`) tại `services/simulator/Dockerfile` (cổng `3001`) và `services/processor/Dockerfile` (cổng `3002`).
   - Cả 2 service đều cung cấp:
     - Liveness probe: `GET /healthz`
     - Readiness probe: `GET /readyz`
     - Prometheus scrape: `GET /metrics`
2. **Hỗ trợ Horizontal Pod Autoscaling (HPA) cho `processor`:**
   - `processor` đã dùng **MQTT v5 Shared Subscription** (`$share/processor-bridge/...`) và Kafka Consumer Group (`processor-telemetry-group` với 4 partitions mặc định). Role C có thể cấu hình HPA scale từ `1` lên `4` replicas cho `processor` mà không lo trùng bản tin!
   - Nếu tăng số replica tối đa của HPA vượt quá 4, chỉ cần tăng biến môi trường `PROCESSOR_KAFKA_PARTITIONS` tương ứng.
3. **Danh sách Custom Prometheus Metrics của Role A (để Role C đưa lên Grafana & đo thực nghiệm):**
   - **Từ `simulator`:**
     - `simulator_telemetry_published_total{zone_id, sensor_type}`
     - `simulator_telemetry_dropped_total{zone_id, reason}`
     - `simulator_valve_commands_received_total{zone_id, action, status}`
     - `simulator_active_sensors`
     - `simulator_drought_mode`
     - `simulator_zone_soil_moisture_percent{zone_id}`
     - `simulator_tick_duration_seconds` (Histogram)
   - **Từ `processor`:**
     - `processor_mqtt_messages_received_total{farm_id}`
     - `processor_raw_kafka_produced_total`
     - `processor_cleaned_messages_total{zone_id, sensor_type, quality}`
     - `processor_invalid_messages_total{reason}`
     - `processor_db_rows_inserted_total`
     - `processor_minio_batches_uploaded_total` & `processor_minio_records_archived_total`
     - `processor_pipeline_end_to_end_latency_seconds` (Histogram — **dùng trực tiếp để báo cáo độ trễ p50 / p95 / p99 của Pipeline!**)
     - `processor_db_flush_duration_seconds` (Histogram)
