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
  "faultySensors": ["s-B-moisture"],
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
| `TWIN_STALE_AFTER_SEC` | 300 | giây thật: quá hạn này không có dữ liệu thì sensor bị coi là cũ |
| `SIM_TIME_SCALE` | (tự suy) | như controller; dùng để quy khoảng cách giữa hai bản tin ra phút ruộng khi cộng dồn nguy cơ nấm |
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
| Tưới sớm theo dự đoán (`idle → pending`) | chưa khô nhưng analytics dự đoán sau `CTRL_PREDICT_HOURS` giờ ruộng độ ẩm `< dryBelow`; lý do ghi `dự đoán 1h: 44.6% < 45% (hiện 45.4%)`. Chỉ dùng hệ số đã calibrate cho zone đó |
| Xác nhận (`pending → watering`) | van báo `open` với đúng `commandId` (hoặc `ts` mới hơn lệnh) |
| Van không xác nhận lệnh mở | quá `CTRL_ACK_TIMEOUT_SEC`: lệnh `open` thành `failed`, gửi thêm lệnh `close` để an toàn, sinh cảnh báo `valve_ack_timeout` |
| Đóng van | độ ẩm ≥ `optimalLow + CTRL_STOP_FRACTION × (optimalHigh − optimalLow)`, hoặc chạy quá `CTRL_MAX_RUN_SEC`, hoặc mất dữ liệu độ ẩm |
| Nghỉ (`cooldown`) | ít nhất `CTRL_MIN_REST_SEC` trước khi được mở lại |

Ví dụ zone-B (tối ưu 55-80%): mở khi < 55%, đóng khi đạt 67,5%.
Thiếu dữ liệu thì không mở. Van đang mở do nguồn khác thì không can thiệp.
Pipeline không có số đo mưa nên controller không chặn tưới khi trời mưa (giới hạn đã biết, không nằm trong yêu cầu).

**Dự đoán.** Controller chỉ hỏi `POST {ANALYTICS_URL}/forecast` khi dự đoán có thể đổi quyết định: van đang nghỉ và đóng, zone có dữ liệu, chưa khô và có nhiệt độ. Request gửi `zoneId`, độ ẩm, nhiệt độ hiện tại của twin (`temp`) và ngưỡng của zone, timeout 1 s. Analytics lỗi, chậm hoặc chưa calibrate zone đó thì controller dùng luật theo ngưỡng như cũ; các chốt an toàn (nghỉ, chạy tối đa, không tưới khi `unknown`) không đổi. Metric `controller_predictions_total{result=ok|none|error}`.

Lệnh gửi lên MQTT `farm/{farmId}/zone/{zoneId}/actuator/valve/cmd` (payload `ValveCommandMessage`, `actuatorId = valve-<zoneId>`) và ghi bảng `commands`. Cột `status`:

| Lệnh | Vòng đời |
|---|---|
| `open` | `sent` → `acknowledged` (van báo mở) → `completed` (đã đóng); `failed` nếu van không xác nhận trong `CTRL_ACK_TIMEOUT_SEC` |
| `close` | `sent` → `completed` khi van báo `closed` với đúng `commandId`; `failed` nếu quá `CTRL_ACK_TIMEOUT_SEC` (kèm cảnh báo `valve_ack_timeout`; xác nhận muộn vẫn chuyển sang `completed`) |

### Cảnh báo

| rule | category | severity | Mở | Đóng |
|---|---|---|---|---|
| `soil_dry` | water_stress | warning | ẩm < `dryBelow` | ẩm ≥ `dryBelow + 4` |
| `soil_critical` | drought | critical | ẩm < `criticalBelow` | ẩm ≥ `criticalBelow + 4` |
| `zone_unknown` | sensor_fault | warning | `status = unknown` | có lại dữ liệu |
| `sensor_fault` | sensor_fault | warning | `faultySensors` không rỗng | `faultySensors` rỗng |
| `fungal_risk` | fungal_risk | warning | `fungalRisk ≥ 0.7` | `fungalRisk < 0.4` |
| `valve_ack_timeout` | system | warning | van không xác nhận lệnh mở, hoặc lệnh đóng (van có thể vẫn đang tưới) | van xác nhận lệnh mở hoặc lệnh đóng sau đó |

`zone_unknown` và `sensor_fault` chỉ mở khi điều kiện đúng liên tục ít nhất `CTRL_UNKNOWN_CONFIRM_SEC` / `CTRL_FAULT_CONFIRM_SEC` giây (giờ thật). Mục đích là lọc lỗi ngẫu nhiên chỉ kéo dài một tick của simulator và khoảng trống dữ liệu lúc khởi động.

Mỗi sự cố có MỘT `alertId` cho cả vòng đời. Sau khi đóng, cùng rule trên cùng zone chỉ mở lại được sau `CTRL_ALERT_COOLDOWN_SEC`.

- Bảng `alerts`: chèn một dòng khi mở (`ts` = lúc mở, `rule`), cập nhật `closed_at` khi đóng (migration `005_alert_lifecycle.sql`). `closed_at IS NULL` nghĩa là đang mở.
- Kafka topic `alerts`: payload `TwinAlertEvent` = `AlertEventSchema` của Role A + `rule`, `state` (`open|closed`), `value`. Consumer chỉ biết schema của A vẫn parse được.
- Telegram nếu có `TELEGRAM_TOKEN` và `TELEGRAM_CHAT_ID`, nếu không thì chỉ log.

Khởi động lại: controller nạp từ DB các cảnh báo đang mở và lệnh gần nhất của mỗi zone (kể cả lệnh `close` còn chờ xác nhận), nên không mở cảnh báo trùng và không tưới lại ngay.

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
| `CTRL_PREDICT` | 1 | `0` = tắt tưới sớm theo dự đoán |
| `CTRL_PREDICT_HOURS` | 1 | tầm dự đoán, **giờ ruộng** (mô hình đáng tin ở 1–3 giờ) |
| `ANALYTICS_URL` | http://localhost:3012 | |
| `SIM_TIME_SCALE` | (tự suy) | số giây ruộng trong 1 giây thật. Không đặt thì suy từ `SIMULATOR_TICK_INTERVAL_MS` và `SIMULATOR_PHYSICS_MINUTES_PER_TICK` (mặc định của simulator: 60). Nông trại thật: `1` |
| `CTRL_TICK_SEC` | khoảng 10 phút ruộng, trong 1–10 s | giây thật (60 lần: 10 s; 300 lần: 2 s) |
| `CTRL_STOP_FRACTION` | 0.5 | vị trí điểm đóng van trong khoảng tối ưu |
| `CTRL_MAX_RUN_SEC` | 1800 | **giây ruộng**, tự chia theo tỉ lệ |
| `CTRL_MIN_REST_SEC` | 3600 | **giây ruộng**, tự chia theo tỉ lệ |
| `CTRL_ACK_TIMEOUT_SEC` | 30 | giây thật |
| `CTRL_ALERT_COOLDOWN_SEC` | 600 | **giây ruộng**, tự chia theo tỉ lệ |
| `CTRL_FAULT_CONFIRM_SEC` | 15 | lỗi cảm biến phải kéo dài chừng này mới mở `sensor_fault` (giờ thật, không chia theo tốc độ mô phỏng) |
| `CTRL_UNKNOWN_CONFIRM_SEC` | 60 | mất dữ liệu phải kéo dài chừng này mới mở `zone_unknown` (giờ thật) |

**Tỉ lệ thời gian.** Simulator chạy nhanh `SIMULATOR_PHYSICS_MINUTES_PER_TICK × 60000 / SIMULATOR_TICK_INTERVAL_MS` lần (mặc định 60) trong khi `ts` của bản tin là giờ thật. Controller tự suy tỉ lệ này từ cùng file `.env` (hoặc `SIM_TIME_SCALE`) và chia các mốc tính bằng giây ruộng; log khởi động in ra giá trị thật đang dùng, ví dụ `timeScale=300x -> real seconds: tick=2 maxRun=6 minRest=12 ...`. `CTRL_ACK_TIMEOUT_SEC` và `CTRL_*_CONFIRM_SEC` là độ trễ thật, không chia. Lý do trong `commands.reason` (ví dụ `quá 6s`) ghi theo giây thật.

---

## 3. Analytics (3012)

| Method | Path | Body | Mô tả |
|---|---|---|---|
| POST | `/forecast` | `{moisture, horizonHours?=6 (1-48), irrigation?: [{startHour,durationHours}], zoneId?, temp?, optimalMin?, optimalMax?, lat?, lon?}` | `{calibrated, points}`: quỹ đạo độ ẩm theo giờ ruộng. `zoneId`: dùng hệ số của zone. `temp`: coi nhiệt độ không đổi, không mưa, không gọi nguồn thời tiết. `calibrated = false`: hệ số mặc định, không nên tin |
| POST | `/whatif` | `{moisture, horizonHours?=24 (1-72), schedules: [{name, windows}], zoneId?, lat?, lon?}` | So sánh lịch tưới; trả `scenarios[]` và `best` |
| GET | `/model` | | `{params, fit, zones}`: hệ số chung và hệ số theo zone kèm kết quả fit |
| POST | `/model/calibrate` | `{zoneId?, samples: [{tsMs, moisture, temp, rain, open}]}` hoặc `{zoneId?, csv}` | Fit lại hệ số từ lịch sử (>= 10 mẫu); có `zoneId` thì chỉ ghi hệ số của zone đó. Lưu vào `ANALYTICS_MODEL_FILE`, khởi động lại vẫn còn. `csv` là đúng nội dung `export-samples` in ra. Mẫu theo **giờ ruộng**, bước 1 giờ; `open` là phần thời gian van mở trong bước (0..1) |
| GET | `/healthz` `/readyz` `/metrics` | | Metric: `analytics_requests_total` |

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `ANALYTICS_PORT` (hoặc `PORT`) | 3012 | |
| `WEATHER` | (Open-Meteo) | `constant` = không gọi Open-Meteo |
| `FARM_LAT` `FARM_LON` | 11.9404, 108.4583 | Lâm Đồng |
| `ANALYTICS_MODEL_FILE` | `.data/analytics-model.json` | file hệ số đã calibrate (`.data/` không commit) |

Lỗi nguồn thời tiết trả 502. Hệ số mặc định chỉ là giá trị khởi tạo: PHẢI chạy `/model/calibrate` bằng dữ liệu thật trước khi tin dự đoán (controller bỏ qua dự đoán khi `calibrated = false`).

### Fit mô hình từ dữ liệu trong DB

```bash
# 1. Xuất mẫu giờ ruộng của một zone (đọc sensor_readings + commands), chỉ lấy khoảng đang bật hạn hán
npm run export-samples -- --zone zone-B --from 2026-11-21T08:23:15Z --to 2026-11-21T08:32:30Z --scale 600 > zone-B.csv
# 2. Fit trên 70% đầu, đánh giá MAE/RMSE trên 30% sau so với baseline (tham số 2 = khoảng ẩm tối ưu của zone)
npm run eval -- zone-B.csv 55,80
# 3. Nạp hệ số của zone vào analytics đang chạy (lưu file, controller dùng ngay)
node -e 'process.stdout.write(JSON.stringify({zoneId:"zone-B",csv:require("fs").readFileSync("zone-B.csv","utf8")}))' \n  | curl -X POST -H 'Content-Type: application/json' --data-binary @- http://localhost:3012/model/calibrate
```

`export-samples` quy giờ thật sang giờ ruộng theo `--scale` (mặc định suy từ `.env` hiện tại; phải là tỉ lệ LÚC thu dữ liệu), gom bản tin chất lượng tốt thành bước 1 giờ ruộng (trung bình độ ẩm đất và nhiệt độ), tính khoảng van mở từ bảng `commands` (từ lúc van xác nhận tới lệnh đóng hoặc hết `durationSec`), và ghi `rain = 0`. Cùng file CSV có thể gửi cho `/model/calibrate`.

Lưu ý về dữ liệu:
- Pipeline không có số đo mưa. Lấy mẫu fit trong lúc simulator bật hạn hán (khi đó mưa = 0 là đúng thật); hệ số mưa `rainGain` vì vậy không được fit.
- Không gộp dữ liệu của các lần chạy có tốc độ simulator khác nhau vào một lần xuất.
- Không có `temp`, `/forecast` lấy dự báo thật của hôm nay, còn simulator phát lại thời tiết 8–15/5/2025. Controller luôn gửi `temp` của twin nên không bị lệch; khi gọi tay để demo thì truyền `temp` hoặc dùng `WEATHER=constant`.

---

## 4. Image container (giao cho Role C)

Mỗi service có Dockerfile multi-stage trong thư mục của nó, cùng mẫu với simulator/processor của Role A: build `tsc` → chạy `node dist/index.js`, nền `node:22-alpine`, user `node` (không root), không có `.env` trong image. Build từ gốc repo:

```bash
docker build -f services/twin-service/Dockerfile -t dtf-twin-service .
docker build -f services/controller/Dockerfile   -t dtf-controller .
docker build -f services/analytics/Dockerfile    -t dtf-analytics .
```

| Image | Cổng | Probe | Ổ lưu trữ |
|---|---|---|---|
| `dtf-twin-service` | 3010 | `/healthz`, `/readyz`, `/metrics` | không (trạng thái nằm trong Postgres) |
| `dtf-controller` | 3011 | như trên (`/readyz` 503 tới khi tick đầu thành công) | không |
| `dtf-analytics` | 3012 | như trên | `/data` (`ANALYTICS_MODEL_FILE=/data/analytics-model.json` đặt sẵn trong image): hệ số đã calibrate; không gắn ổ thì mất khi xóa container |

Mọi cấu hình truyền bằng biến môi trường (danh sách ở mục 1–3). Trong container `localhost` là chính container, nên PHẢI đặt lại địa chỉ:

| Biến | Service | Giá trị trong mạng compose dev (`deploy_default`) |
|---|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT` (hoặc `DATABASE_URL`) | twin, controller | `timescaledb`, `5432` |
| `KAFKA_BROKERS` | twin, controller | `kafka:29092` (listener nội bộ; `localhost:9092` chỉ dùng từ máy host) |
| `MQTT_BROKER_URL` | twin, controller | `mqtt://mosquitto:1883` |
| `TWIN_URL`, `ANALYTICS_URL` | controller | `http://<tên container twin>:3010`, `http://<tên container analytics>:3012` |
| `SIM_TIME_SCALE` hoặc `SIMULATOR_TICK_INTERVAL_MS` + `SIMULATOR_PHYSICS_MINUTES_PER_TICK` | twin, controller | PHẢI khớp tốc độ simulator đang chạy |

Không đặt `ANALYTICS_MODEL_FILE` rỗng (trong `--env-file`, ConfigMap...): biến rỗng ghi đè giá trị `/data/analytics-model.json` của image, analytics quay về đường dẫn không ghi được và `/model/calibrate` trả 500. `.env.example` để dòng này ở dạng comment; muốn đặt thì dùng `/data/analytics-model.json`.

Trên Windows với Git Bash, đặt `export MSYS_NO_PATHCONV=1` trước các lệnh dưới (nếu không, `/data` bị đổi thành đường dẫn Windows và analytics không ghi được hệ số).

Ví dụ chạy cả ba trên hạ tầng `npm run infra:up` (đã chạy đạt ngày 2026-11-21, simulator/processor chạy bằng `npm`):

```bash
COMMON="--network deploy_default --env-file .env -e POSTGRES_HOST=timescaledb -e POSTGRES_PORT=5432   -e KAFKA_BROKERS=kafka:29092 -e MQTT_BROKER_URL=mqtt://mosquitto:1883"
docker run -d --name b-analytics $COMMON -e ANALYTICS_MODEL_FILE=/data/analytics-model.json   -v b-analytics-data:/data -p 3012:3012 dtf-analytics
docker run -d --name b-twin $COMMON -p 3010:3010 dtf-twin-service
docker run -d --name b-controller $COMMON -e TWIN_URL=http://b-twin:3010 -e ANALYTICS_URL=http://b-analytics:3012   -p 3011:3011 dtf-controller
```

---

## 5. Chạy local

Cần `.env` (chép từ `.env.example`, có sẵn `TWIN_STORE=pg`, `TWIN_INGEST=kafka`, `CONTROLLER_STORE=pg`). Mỗi lệnh một terminal:

```bash
npm run infra:up        # Postgres/Timescale, Kafka, Mosquitto, MinIO (deploy/docker-compose.dev.yml)
npm run db:setup        # migration 001-005 + seed farm-01
npm run dev:simulator   # Role A, cổng 3001
npm run dev:processor   # Role A, cổng 3002
npm run dev:twin
npm run dev:controller
npm run dev:analytics   # không cần cho vòng tưới
```

Không có hạ tầng: đặt `ENABLE_DEV_INGEST=1`, chạy `npm run dev:twin`, rồi `npm run fake-feed`.

### Kiểm thử vòng tưới (đã chạy đạt ngày 2026-11-21)

Để thấy kết quả trong vài phút, đặt trong `.env`: `SIMULATOR_TICK_INTERVAL_MS=1000` (nhanh 300 lần) và `SIMULATOR_DROUGHT_MODE=true`, rồi chạy lại cả bốn service. Mọi service đọc cùng `.env` nên tự dùng chung tỉ lệ; không cần chỉnh `CTRL_*`.

Kết quả mong đợi: zone xuống dưới `dryBelow` thì mở `soil_dry`; van mở và được xác nhận trong vài giây; độ ẩm tăng; van đóng khi đạt điểm giữa khoảng tối ưu hoặc hết `CTRL_MAX_RUN_SEC` (mặc định 30 phút ruộng, ở 300 lần là 6 s thật); nghỉ ít nhất `CTRL_MIN_REST_SEC` (1 giờ ruộng) rồi mới tưới lại; cảnh báo đóng khi vượt `dryBelow + 4`. Mọi lệnh trong `commands` kết thúc ở `completed`.

Với mặc định, khi bật hạn hán một lần tưới 30 phút ruộng chỉ nâng độ ẩm vài điểm, nên zone dao động quanh ngưỡng khô thay vì lên tới điểm giữa. Muốn thấy van đóng vì đạt mục tiêu thì tăng `CTRL_MAX_RUN_SEC` (ví dụ `18000` = 5 giờ ruộng).

API của simulator (Role A) để tạo tình huống:

| Việc | Lệnh |
|---|---|
| Bật/tắt hạn hán | `POST :3001/simulation/scenario` `{"droughtMode": true}` |
| Tiêm lỗi cảm biến | `POST :3001/simulation/faults` `{"sensorId": "s-A-humidity", "mode": "stuck"}` (`dropout`, `stuck`, `out_of_range`, `drift`) |
| Gỡ mọi lỗi | `POST :3001/simulation/faults` `{"clearAll": true}` |
| Xem trạng thái vật lý | `GET :3001/simulation/state` |

Đừng tiêm lỗi vào cảm biến độ ẩm đất của zone đang test tưới: zone thành `unknown` và controller (đúng thiết kế) sẽ không tưới.

## 6. Giới hạn đã biết

- Lỗi `drift` của simulator không có cờ chất lượng riêng; chỉ phát hiện được khi giá trị vượt giới hạn vật lý (`out_of_range`).
- Không có số đo mưa (xem mục 2 và 3).
- C cần: image (mục 4), các biến môi trường ở trên, import `monitoring/grafana/farm-twin.json`.
