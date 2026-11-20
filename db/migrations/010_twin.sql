-- Ghi bởi: twin-service
CREATE TABLE IF NOT EXISTS twin_state (
  zone_id    TEXT PRIMARY KEY,
  farm_id    TEXT NOT NULL,
  state      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS twin_state_status_idx ON twin_state ((state->>'status'));

-- Ghi bởi: controller
CREATE TABLE IF NOT EXISTS commands (
  command_id   TEXT PRIMARY KEY,
  zone_id      TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('open','close')),
  duration_sec INTEGER,
  reason       TEXT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS commands_zone_ts_idx ON commands (zone_id, ts DESC);

-- Ghi bởi: controller (một dòng cho mỗi vòng đời cảnh báo; closed_at NULL = đang mở)
CREATE TABLE IF NOT EXISTS alerts (
  alert_id  TEXT PRIMARY KEY,
  zone_id   TEXT NOT NULL,
  rule      TEXT NOT NULL,
  severity  TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  message   TEXT NOT NULL,
  value     DOUBLE PRECISION,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS alerts_open_idx ON alerts (zone_id, rule) WHERE closed_at IS NULL;
