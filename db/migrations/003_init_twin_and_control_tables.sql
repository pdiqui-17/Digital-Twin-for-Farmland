-- ============================================================================
-- Migration 003: Các bảng nghiệp vụ của Twin Core (twin_state, commands, alerts)
-- Quyền ghi:
--   - twin_state : Twin Service (Role B)
--   - commands   : Controller (Role B)
--   - alerts     : Twin Service, Controller (Role B)
-- ============================================================================

CREATE TABLE IF NOT EXISTS twin_state (
  zone_id TEXT PRIMARY KEY REFERENCES zones(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  water_stress_index DOUBLE PRECISION,
  fungal_risk_index DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_twin_state_farm_id ON twin_state(farm_id);

CREATE TABLE IF NOT EXISTS commands (
  command_id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  actuator_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('open', 'close')),
  duration_sec INTEGER CHECK (duration_sec IS NULL OR duration_sec > 0),
  reason TEXT,
  issued_by TEXT NOT NULL DEFAULT 'controller',
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'acknowledged', 'completed', 'failed')),
  ts TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_commands_zone_ts ON commands (zone_id, ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  category TEXT NOT NULL CHECK (
    category IN ('drought', 'water_stress', 'fungal_risk', 'sensor_fault', 'system')
  ),
  message TEXT NOT NULL,
  metadata JSONB,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ts TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_zone_ts ON alerts (zone_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_ts ON alerts (severity, ts DESC);
