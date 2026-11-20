# API và cấu hình - Role B

## Twin Service (cổng mặc định 3001)

| Method | Path | Mô tả |
|---|---|---|
| GET | `/zones` | Danh sách trạng thái mọi zone |
| GET | `/zones/:id` | Trạng thái một zone (`ZoneState`, xem `packages/shared/src/schemas.ts`); 404 nếu chưa có |
| GET | `/zones/:id/history?metric=soil_moisture&from=ISO&to=ISO&limit=500` | Lịch sử từ `sensor_readings`; `metric` là một `SensorType` |
| GET | `/stream?zone=zone-A` | SSE, event `zone` mỗi khi trạng thái đổi (bỏ `zone` để nhận tất cả) |
| POST | `/ingest` | CHỈ khi `ENABLE_DEV_INGEST=1`: nhận một hoặc mảng `Reading` (dùng cho `scripts/fake-feed.ts`) |
| GET | `/healthz` `/readyz` `/metrics` | Probe và Prometheus |

Metrics: `twin_readings_applied_total`, `twin_readings_dropped_total{reason}`, `twin_zone_status{zone,status}`, `twin_ingest_lag_seconds`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3001 | |
| `STORE` | memory | `pg` để dùng Postgres |
| `DATABASE_URL` | | bắt buộc khi `STORE=pg` |
| `INGEST` | (không) | `kafka` để consume `telemetry.clean` |
| `KAFKA_BROKERS` | localhost:9092 | |
| `MQTT_URL` | (không) | nếu đặt: subscribe trạng thái van `farm/+/zone/+/actuator/valve/state` |
| `MQTT_USERNAME` `MQTT_PASSWORD` | | |
| `FARM_ID` | farm-1 | farm mặc định khi reading không có `farmId` |
| `ENABLE_DEV_INGEST` | 0 | bật `/ingest` (KHÔNG bật ở production) |

Giả định về bảng của role A (cần xác nhận): `sensor_readings(ts, sensor_id, zone_id, type, value, quality)`.

## Controller (cổng 3002)

Không có API nghiệp vụ; vòng lặp mỗi `TICK_SEC` giây. Endpoint: `/healthz`, `/readyz` (503 cho đến khi một tick thành công), `/metrics`.
Metrics: `controller_commands_total{action}`, `controller_alerts_total{rule,state}`, `controller_tick_errors_total`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3002 | |
| `TWIN_URL` | http://localhost:3001 | |
| `MQTT_URL` | (không) | không đặt thì chỉ ghi log lệnh (không điều khiển thật) |
| `STORE` / `DATABASE_URL` | memory | `pg` ghi bảng `commands`, `alerts` |
| `KAFKA_BROKERS` | (không) | publish sự kiện lên topic `alerts` |
| `TELEGRAM_TOKEN` `TELEGRAM_CHAT_ID` | | thiếu thì chỉ log |
| `AUTO_IRRIGATION` | 1 | `0` = chỉ cảnh báo, không tự tưới |
| `TICK_SEC` | 10 | |
| `FARM_ID` | farm-1 | |

Luật mặc định (sửa trong `DEFAULT_IRRIGATION` và `defaultRules`): mở van khi độ ẩm < 26%, đóng khi >= 34%, tối đa 1800 s mỗi lần, nghỉ tối thiểu 3600 s, chờ ack 30 s, không tưới khi mưa >= 0.5 mm/h; thiếu dữ liệu thì không mở và đóng van nếu đang tưới.

Cảnh báo: `soil_dry` (mở < 28, đóng >= 32), `soil_critical` (mở < 22, đóng >= 26), `zone_unknown`, `fungal_risk` (mở >= 0.7, đóng < 0.4), `valve_ack_timeout`. Cooldown mở lại 600 s.

## Analytics (cổng 3003)

| Method | Path | Body | Mô tả |
|---|---|---|---|
| POST | `/forecast` | `{moisture, horizonHours?=6 (1-48), irrigation?: [{startHour,durationHours}], lat?, lon?}` | Quỹ đạo độ ẩm theo giờ |
| POST | `/whatif` | `{moisture, horizonHours?=24 (1-72), schedules: [{name, windows}], lat?, lon?}` | So sánh lịch tưới; trả `scenarios[]` và `best` |
| GET | `/model` | | Hệ số hiện tại và kết quả fit |
| POST | `/model/calibrate` | `{samples: [{tsMs, moisture, temp, rain, open}]}` | Fit lại hệ số từ lịch sử (>= 10 mẫu) |

Biến môi trường: `PORT` (3003), `WEATHER=constant` (không gọi Open-Meteo), `FARM_LAT` `FARM_LON`.
Lỗi nguồn thời tiết trả 502. Hệ số mặc định chỉ là giá trị khởi tạo: PHẢI chạy `/model/calibrate` bằng dữ liệu thật trước khi tin dự đoán.

## Việc cần role A / C xác nhận

- A: tên cột `sensor_readings`; chạy simulator ở chế độ tăng tốc để có dữ liệu hiệu chỉnh sớm; simulator phát trạng thái van lên `.../valve/state` với payload `{"state":"open|closed","commandId":"...","ts":"ISO"}`.
- C: image (`deploy/Dockerfile.service`), các biến môi trường ở trên, import `monitoring/grafana/farm-twin.json`.
