-- ============================================================================
-- Migration 001: Bảng danh mục (farms, zones, sensors, actuators)
-- Quyền ghi: db/seed (Role A) | Quyền đọc: Tất cả các service
-- ============================================================================

CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  area_hectares DOUBLE PRECISION NOT NULL CHECK (area_hectares > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  crop_type TEXT NOT NULL,
  soil_type TEXT NOT NULL CHECK (soil_type IN ('sandy', 'loam', 'clay')),
  area_sqm DOUBLE PRECISION NOT NULL CHECK (area_sqm > 0),
  moisture_optimal_min DOUBLE PRECISION NOT NULL CHECK (moisture_optimal_min >= 0 AND moisture_optimal_min <= 100),
  moisture_optimal_max DOUBLE PRECISION NOT NULL CHECK (
    moisture_optimal_max >= 0
    AND moisture_optimal_max <= 100
    AND moisture_optimal_max >= moisture_optimal_min
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zones_farm_id ON zones(farm_id);

CREATE TABLE IF NOT EXISTS sensors (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('soil_moisture', 'air_temperature', 'air_humidity', 'light_intensity')),
  unit TEXT NOT NULL CHECK (unit IN ('percent', 'celsius', 'lux')),
  min_valid DOUBLE PRECISION NOT NULL,
  max_valid DOUBLE PRECISION NOT NULL CHECK (max_valid > min_valid),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'faulty', 'offline')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sensors_zone_id ON sensors(zone_id);
CREATE INDEX IF NOT EXISTS idx_sensors_farm_id ON sensors(farm_id);

CREATE TABLE IF NOT EXISTS actuators (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'valve' CHECK (type IN ('valve')),
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('open', 'closed')),
  flow_rate_lpm DOUBLE PRECISION NOT NULL DEFAULT 25.0 CHECK (flow_rate_lpm >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actuators_zone_id ON actuators(zone_id);
