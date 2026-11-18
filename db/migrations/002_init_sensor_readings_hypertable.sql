-- ============================================================================
-- Migration 002: Bảng chuỗi thời gian sensor_readings (TimescaleDB Hypertable)
-- Quyền ghi: services/processor (Role A)
-- Quyền đọc: Twin Service, Analytics, Grafana
--
-- Lưu ý thiết kế:
-- 1. Không gắn khóa ngoại cứng sensor_id -> sensors(id) để hỗ trợ nạp tốc độ cao
--    và kịch bản mở rộng 500+ sensor ảo động khi chạy Load Test mà không nghẽn khóa.
-- 2. Ràng buộc UNIQUE (zone_id, sensor_id, ts) giúp Processor ghi idempotent
--    (ON CONFLICT DO NOTHING) khi Kafka redeliver message, đồng thời tương thích
--    hoàn toàn với compress_segmentby = 'zone_id, sensor_id' của TimescaleDB.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS sensor_readings (
  ts TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  farm_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  sensor_type TEXT NOT NULL CHECK (
    sensor_type IN ('soil_moisture', 'air_temperature', 'air_humidity', 'light_intensity')
  ),
  value DOUBLE PRECISION NOT NULL,
  raw_value DOUBLE PRECISION,
  unit TEXT NOT NULL CHECK (unit IN ('percent', 'celsius', 'lux')),
  quality TEXT NOT NULL DEFAULT 'ok' CHECK (
    quality IN ('ok', 'noisy_smoothed', 'out_of_range', 'stuck', 'missing_signal')
  ),
  CONSTRAINT uq_sensor_readings_zone_sensor_ts UNIQUE (zone_id, sensor_id, ts)
);

-- Chuyển thành Hypertable phân vùng theo cột thời gian `ts` (mỗi chunk 1 ngày)
SELECT create_hypertable(
  'sensor_readings',
  by_range('ts', INTERVAL '1 day'),
  if_not_exists => TRUE
);

-- Index tối ưu truy vấn lịch sử theo zone + loại cảm biến (cho Twin, Analytics, Grafana)
CREATE INDEX IF NOT EXISTS idx_sensor_readings_zone_type_ts
  ON sensor_readings (zone_id, sensor_type, ts DESC);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts
  ON sensor_readings (sensor_id, ts DESC);

-- Bật nén cột (Columnar Compression) cho các chunk cũ hơn 7 ngày
ALTER TABLE sensor_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'zone_id, sensor_id',
  timescaledb.compress_orderby = 'ts DESC'
);

SELECT add_compression_policy(
  'sensor_readings',
  compress_after => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Chính sách lưu giữ (Retention Policy): tự động xóa các chunk chi tiết cũ hơn 30 ngày
SELECT add_retention_policy(
  'sensor_readings',
  drop_after => INTERVAL '30 days',
  if_not_exists => TRUE
);
