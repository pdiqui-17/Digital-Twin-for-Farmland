# API và cấu hình - Role B (Twin Core)

Ba service của Role B chạy trên hạ tầng và luồng dữ liệu của Role A:

```
simulator --MQTT--> processor --Kafka telemetry.clean--> twin-service --HTTP/SSE--> controller --MQTT .../valve/cmd--> simulator
                        |                                    ^                          |
                        +--> sensor_readings (TimescaleDB)   +-- MQTT .../valve/state --+--> commands, alerts (Postgres), Kafka alerts
```

| Service | Cổng | Ghi bảng |
|---|---|---|
| twin-service | 3010 | `twin_state` |
| controller | 3011 | `commands`, `alerts` (writer duy nhất của `alerts`) |
| analytics | 3012 | (không) |

Role A dùng 3001 (simulator) và 3002 (processor). Mọi service đọc chung file `.env` ở gốc repo (xem `.env.example`).
Kết nối DB: dùng `DATABASE_URL` nếu đặt, nếu không thì ghép từ `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB` (cùng quy ước với `db/migrate.ts`).

Hợp đồng dữ liệu của Role B nằm ở `packages/shared/src/twin.ts` (export qua `@digital-twin/shared`). Schema của Role A trong `schemas.ts` và `topics.ts` không bị sửa.

---

## 1. Twin Service (3010)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/zones` | Mảng `ZoneState` của mọi zone |
| GET | `/zones/:id` | Một `ZoneState`; 404 `{"error":"zone_not_found"}` nếu chưa có |
| GET | `/zones/:id/history?metric=soil_moisture&from=ISO&to=ISO&limit=500` | Lịch sử từ `sensor_readings`. `metric` là một `SensorType`; `limit` 1-5000. Trả `{zoneId, metric, points}`. 400 `invalid_metric` / `invalid_time` |
| GET | `/stream?zone=zone-A` | SSE, event `zone` (data là `ZoneState`) mỗi khi trạng thái đổi; heartbeat 15 s. Bỏ `zone` để nhận tất cả |
| POST | `/ingest` | CHỈ khi `ENABLE_DEV_INGEST=1`: nhận một hoặc mảng bản tin cảm biến (dùng cho `npm run fake-feed`) |
| GET | `/healthz` `/readyz` `/metrics` | Probe (`/readyz` 503 cho đến khi sẵn sàng) và Prometheus |

### `ZoneState` (cũng là cột `twin_state.state`)

```jsonc
{
  "zoneId": "zone-B", "farmId": "farm-01",
  "updatedAt": "ISO", "lastDataAt": "ISO | null",
  "sensors": { "<sensorId>": { "type": "soil_moisture", "value": 52.1, "unit": "percent", "ts": "ISO", "quality": "ok" } },
  "metrics": { "soilMoisture": 52.1, "airTemperature": 21.4, "airHumidity": 78, "lightIntensity": 12000 },
  "derived": { "waterStress": 0.12, "fungalRisk": 0.3, "fungalAccumMin": 40 },
  "faultySensors": ["sm-zone-B-1"],
  "valve": { "state": "open | closed | unknown", "ts": "ISO | null", "lastCommandId": "cmd-..." },
  "thresholds": { "optimalLow": 55, "optimalHigh": 80, "dryBelow": 55, "criticalBelow": 45,
                  "wiltingPoint": 35, "fieldCapacity": 90, "staleAfterSec": 300 },
  "status": "ok | dry | critical | unknown"
}
```

- **Chất lượng dữ liệu** (cờ của processor): chỉ `ok` và `noisy_smoothed` được dùng để tính `metrics`. Bản tin `out_of_range`, `stuck`, `missing_signal` vẫn được ghi vào `sensors`, nhưng không tính vào `metrics`; sensor đó (nếu còn tươi) được đưa vào `faultySensors`.
- **Ngưỡng theo zone**: đọc `zones.moisture_optimal_min/max` khi `STORE=pg`, rồi suy ra bằng `deriveThresholds()`:
  `dryBelow = optimalMin`, `criticalBelow = optimalMin - 10`, `wiltingPoint = optimalMin - 20`, `fieldCapacity = optimalMax + 10`.
  Zone không có trong danh mục (hoặc `STORE=memory`) dùng `DEFAULT_THRESHOLDS` (45-70%).
- **status**: `unknown` khi không có độ ẩm đất dùng được trong `staleAfterSec`; `critical` khi < `criticalBelow`; `dry` khi < `dryBelow`; còn lại `ok`.
- **Van**: twin subscribe `farm/+/zone/+/actuator/valve/state` để cập nhật `valve`.

Metrics: `twin_readings_applied_total`, `twin_readings_dropped_total{reason}`, `twin_messages_invalid_total`, `twin_zone_status{zone,status}`, `twin_ingest_lag_seconds`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `TWIN_PORT` (hoặc `PORT`) | 3010 | |
| `TWIN_STORE` (hoặc `STORE`) | memory | `pg` = đọc `zones`, ghi `twin_state`, đọc lịch sử `sensor_readings` |
| `TWIN_INGEST` (hoặc `INGEST`) | none | `kafka` = consume `telemetry.clean` |
| `KAFKA_BROKERS` | localhost:9092 | |
| `TWIN_KAFKA_GROUP` | twin-service | consumer group |
| `MQTT_URL` (hoặc `MQTT_BROKER_URL`) | (không) | nếu đặt: subscribe trạng thái van |
| `MQTT_USERNAME` `MQTT_PASSWORD` | | |
| `FARM_ID` (hoặc `SIMULATOR_FARM_ID`) | farm-01 | |
| `TWIN_STALE_AFTER_SEC` | 300 | quá hạn này không có dữ liệu thì sensor bị coi là cũ |
| `ENABLE_DEV_INGEST` | 0 | bật `/ingest` (KHÔNG bật ở production) |

Lỗi ghi DB khi xử lý bản tin Kafka được ném ra, không nuốt, để Kafka gửi lại (không mất dữ liệu).

---

## 2. Controller (3011)

Không có API nghiệp vụ. Mỗi `CTRL_TICK_SEC` giây controller đọc `GET {TWIN_URL}/zones`, chạy luật cảnh báo và máy trạng thái van cho từng zone.
Endpoint: `/healthz`, `/readyz` (503 cho đến khi một tick thành công), `/metrics`.
Metrics: `controller_commands_total{action}`, `controller_alerts_total{rule,state}`, `controller_tick_errors_total`.

### Tưới tự động

Máy trạng thái mỗi zone: `idle → pending → watering → cooldown → idle`.

| Bước | Điều kiện |
|---|---|
| Mở van (`idle → pending`) | `soilMoisture < thresholds.dryBelow`; gửi lệnh `open` với `durationSec = CTRL_MAX_RUN_SEC` |
| Xác nhận (`pending → watering`) | van báo `open` với đúng `commandId` (hoặc `ts` mới hơn lệnh) |
| Van không phản hồi | quá `CTRL_ACK_TIMEOUT_SEC`: gửi thêm lệnh `close` để an toàn, sinh cảnh báo `valve_ack_timeout` |
| Đóng van | độ ẩm ≥ `optimalLow + CTRL_STOP_FRACTION × (optimalHigh − optimalLow)`, hoặc chạy quá `CTRL_MAX_RUN_SEC`, hoặc mất dữ liệu độ ẩm |
| Nghỉ (`cooldown`) | ít nhất `CTRL_MIN_REST_SEC` trước khi được mở lại |

Ví dụ zone-B (tối ưu 55-80%): mở khi < 55%, đóng khi đạt 67,5%.
Thiếu dữ liệu thì không mở. Van đang mở do nguồn khác thì không can thiệp.
Chưa có cảm biến mưa nên controller hiện **không** chặn tưới khi mưa.

Lệnh gửi lên MQTT `farm/{farmId}/zone/{zoneId}/actuator/valve/cmd` (payload `ValveCommandMessage`, `actuatorId = valve-<zoneId>`) và ghi bảng `commands` với `status`: `sent → acknowledged → completed | failed`.

### Cảnh báo

| rule | category | severity | Mở | Đóng |
|---|---|---|---|---|
| `soil_dry` | water_stress | warning | ẩm < `dryBelow` | ẩm ≥ `dryBelow + 4` |
| `soil_critical` | drought | critical | ẩm < `criticalBelow` | ẩm ≥ `criticalBelow + 4` |
| `zone_unknown` | sensor_fault | warning | `status = unknown` | có lại dữ liệu |
| `sensor_fault` | sensor_fault | warning | `faultySensors` không rỗng | `faultySensors` rỗng |
| `fungal_risk` | fungal_risk | warning | `fungalRisk ≥ 0.7` | `fungalRisk < 0.4` |
| `valve_ack_timeout` | system | warning | van không xác nhận lệnh mở | (sự kiện một lần) |

Mỗi sự cố có MỘT `alertId` cho cả vòng đời. Sau khi đóng, cùng rule trên cùng zone chỉ mở lại được sau `CTRL_ALERT_COOLDOWN_SEC`.

- Bảng `alerts`: chèn một dòng khi mở (`ts` = lúc mở, `rule`), cập nhật `closed_at` khi đóng (migration `005_alert_lifecycle.sql`). `closed_at IS NULL` nghĩa là đang mở.
- Kafka topic `alerts`: payload `TwinAlertEvent` = `AlertEventSchema` của Role A + `rule`, `state` (`open|closed`), `value`. Consumer chỉ biết schema của A vẫn parse được.
- Telegram nếu có `TELEGRAM_TOKEN` và `TELEGRAM_CHAT_ID`, nếu không thì chỉ log.

Khởi động lại: controller nạp các cảnh báo đang mở và lệnh gần nhất của mỗi zone từ DB, nên không mở cảnh báo trùng và không tưới lại ngay.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `CONTROLLER_PORT` (hoặc `PORT`) | 3011 | |
| `TWIN_URL` | http://localhost:3010 | |
| `CONTROLLER_STORE` (hoặc `STORE`) | memory | `pg` = ghi `commands`, `alerts` |
| `MQTT_URL` (hoặc `MQTT_BROKER_URL`) | (không) | không đặt thì chỉ log lệnh (không điều khiển thật) |
| `MQTT_USERNAME` `MQTT_PASSWORD` | | |
| `KAFKA_BROKERS` | (không) | đặt thì publish lên topic `alerts` |
| `TELEGRAM_TOKEN` `TELEGRAM_CHAT_ID` | | |
| `AUTO_IRRIGATION` | 1 | `0` = chỉ cảnh báo, không tự tưới |
| `CTRL_TICK_SEC` (hoặc `TICK_SEC`) | 10 | |
| `CTRL_STOP_FRACTION` | 0.5 | vị trí điểm đóng van trong khoảng tối ưu |
| `CTRL_MAX_RUN_SEC` | 1800 | |
| `CTRL_MIN_REST_SEC` | 3600 | |
| `CTRL_ACK_TIMEOUT_SEC` | 30 | |
| `CTRL_ALERT_COOLDOWN_SEC` | 600 | |

Khi simulator chạy tăng tốc (`SIMULATOR_PHYSICS_MINUTES_PER_TICK`), các mốc `CTRL_*` tính theo giờ thật, nên cần rút ngắn tương ứng. Hiện chưa có một biến tỉ lệ thời gian dùng chung (đang chờ A và B thống nhất).

---

## 3. Analytics (3012)

| Method | Path | Body | Mô tả |
|---|---|---|---|
| POST | `/forecast` | `{moisture, horizonHours?=6 (1-48), irrigation?: [{startHour,durationHours}], lat?, lon?}` | Quỹ đạo độ ẩm theo giờ |
| POST | `/whatif` | `{moisture, horizonHours?=24 (1-72), schedules: [{name, windows}], lat?, lon?}` | So sánh lịch tưới; trả `scenarios[]` và `best` |
| GET | `/model` | | Hệ số hiện tại và kết quả fit |
| POST | `/model/calibrate` | `{samples: [{tsMs, moisture, temp, rain, open}]}` | Fit lại hệ số từ lịch sử (>= 10 mẫu) |
| GET | `/healthz` `/readyz` `/metrics` | | Metric: `analytics_requests_total` |

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `ANALYTICS_PORT` (hoặc `PORT`) | 3012 | |
| `WEATHER` | (Open-Meteo) | `constant` = không gọi Open-Meteo |
| `FARM_LAT` `FARM_LON` | 11.9404, 108.4583 | Lâm Đồng |

Lỗi nguồn thời tiết trả 502. Hệ số mặc định chỉ là giá trị khởi tạo: PHẢI chạy `/model/calibrate` bằng dữ liệu thật trước khi tin dự đoán.
Chưa có cảm biến mưa nên khi fit hiện coi `rain = 0`.

---

## 4. Chạy local

```bash
npm run infra:up        # Postgres/Timescale, Kafka, Mosquitto, MinIO (deploy/docker-compose.dev.yml)
npm run db:setup        # migration 001-005 + seed farm-01
npm run dev:simulator   # Role A
npm run dev:processor   # Role A
npm run dev:twin        # TWIN_STORE=pg TWIN_INGEST=kafka
npm run dev:controller  # CONTROLLER_STORE=pg
npm run dev:analytics
```

Không có hạ tầng: `ENABLE_DEV_INGEST=1 npm run dev:twin` rồi `npm run fake-feed`.

## 5. Việc còn chờ thống nhất

- A + B: một biến môi trường chung cho tỉ lệ thời gian mô phỏng, để controller tự co các mốc `CTRL_*`.
- A: thêm cảm biến mưa (sau đó controller chặn tưới khi mưa, analytics fit với mưa thật).
- A duyệt migration 005 và quy ước "chỉ controller ghi `alerts`".
- C: image (`deploy/Dockerfile.service`), các biến môi trường ở trên, import `monitoring/grafana/farm-twin.json`.
