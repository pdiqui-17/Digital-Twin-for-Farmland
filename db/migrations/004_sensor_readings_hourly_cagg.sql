-- no-transaction
-- ============================================================================
-- Migration 004: Continuous Aggregate theo giờ cho lưu trữ đa tầng dài hạn
-- Lưu giữ bản tổng hợp theo giờ trong 365 ngày (trong khi bản chi tiết xóa sau 30 ngày)
-- Lưu ý: TimescaleDB yêu cầu CREATE MATERIALIZED VIEW (continuous) chạy ngoài transaction.
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', ts) AS bucket,
  farm_id,
  zone_id,
  sensor_type,
  AVG(value) AS avg_value,
  MIN(value) AS min_value,
  MAX(value) AS max_value,
  COUNT(*) AS sample_count
FROM sensor_readings
WHERE quality IN ('ok', 'noisy_smoothed')
GROUP BY bucket, farm_id, zone_id, sensor_type
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'sensor_readings_hourly',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists => TRUE
);

SELECT add_retention_policy(
  'sensor_readings_hourly',
  drop_after => INTERVAL '365 days',
  if_not_exists => TRUE
);
