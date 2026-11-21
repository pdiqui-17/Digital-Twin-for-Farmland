-- ============================================================================
-- Seed 001: Khởi tạo nông trại mẫu (1 Farm, 4 Zones, 16 Sensors, 4 Valves)
-- Thiết kế Idempotent (ON CONFLICT DO UPDATE) - chạy lại nhiều lần an toàn.
-- ============================================================================

INSERT INTO farms (id, name, latitude, longitude, area_hectares)
VALUES ('farm-01', 'GreenValley Digital Twin Farm (Lam Dong)', 11.9404, 108.4583, 4.0)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  area_hectares = EXCLUDED.area_hectares;

-- 4 phân khu (zones) với đặc tính cây trồng & loại đất khác nhau để thể hiện rõ hành vi vật lý:
-- - zone-A: Cà chua (đất thịt loam - cân bằng)
-- - zone-B: Xà lách (đất pha cát sandy - thoát nước nhanh, nhạy cảm hạn hán nhất)
-- - zone-C: Ớt chuông (đất thịt loam)
-- - zone-D: Dâu tây (đất sét pha clay - giữ ẩm lâu, dễ tăng nguy cơ nấm khi ẩm cao)
INSERT INTO zones (id, farm_id, name, crop_type, soil_type, area_sqm, moisture_optimal_min, moisture_optimal_max)
VALUES
  ('zone-A', 'farm-01', 'Khu A - Cà chua nhà màng', 'tomato', 'loam', 10000, 45.0, 70.0),
  ('zone-B', 'farm-01', 'Khu B - Xà lách luống cát', 'lettuce', 'sandy', 8000, 55.0, 80.0),
  ('zone-C', 'farm-01', 'Khu C - Ớt chuông ngọt', 'bell_pepper', 'loam', 12000, 40.0, 65.0),
  ('zone-D', 'farm-01', 'Khu D - Dâu tây cao sản', 'strawberry', 'clay', 10000, 50.0, 75.0)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  crop_type = EXCLUDED.crop_type,
  soil_type = EXCLUDED.soil_type,
  area_sqm = EXCLUDED.area_sqm,
  moisture_optimal_min = EXCLUDED.moisture_optimal_min,
  moisture_optimal_max = EXCLUDED.moisture_optimal_max;

-- 16 cảm biến cơ sở (4 loại cảm biến x 4 zones)
INSERT INTO sensors (id, zone_id, farm_id, type, unit, min_valid, max_valid, status)
VALUES
  -- Zone A
  ('s-A-moisture', 'zone-A', 'farm-01', 'soil_moisture', 'percent', 0, 100, 'active'),
  ('s-A-temp',     'zone-A', 'farm-01', 'air_temperature', 'celsius', -10, 60, 'active'),
  ('s-A-humidity', 'zone-A', 'farm-01', 'air_humidity', 'percent', 0, 100, 'active'),
  ('s-A-light',    'zone-A', 'farm-01', 'light_intensity', 'lux', 0, 150000, 'active'),
  -- Zone B
  ('s-B-moisture', 'zone-B', 'farm-01', 'soil_moisture', 'percent', 0, 100, 'active'),
  ('s-B-temp',     'zone-B', 'farm-01', 'air_temperature', 'celsius', -10, 60, 'active'),
  ('s-B-humidity', 'zone-B', 'farm-01', 'air_humidity', 'percent', 0, 100, 'active'),
  ('s-B-light',    'zone-B', 'farm-01', 'light_intensity', 'lux', 0, 150000, 'active'),
  -- Zone C
  ('s-C-moisture', 'zone-C', 'farm-01', 'soil_moisture', 'percent', 0, 100, 'active'),
  ('s-C-temp',     'zone-C', 'farm-01', 'air_temperature', 'celsius', -10, 60, 'active'),
  ('s-C-humidity', 'zone-C', 'farm-01', 'air_humidity', 'percent', 0, 100, 'active'),
  ('s-C-light',    'zone-C', 'farm-01', 'light_intensity', 'lux', 0, 150000, 'active'),
  -- Zone D
  ('s-D-moisture', 'zone-D', 'farm-01', 'soil_moisture', 'percent', 0, 100, 'active'),
  ('s-D-temp',     'zone-D', 'farm-01', 'air_temperature', 'celsius', -10, 60, 'active'),
  ('s-D-humidity', 'zone-D', 'farm-01', 'air_humidity', 'percent', 0, 100, 'active'),
  ('s-D-light',    'zone-D', 'farm-01', 'light_intensity', 'lux', 0, 150000, 'active')
ON CONFLICT (id) DO UPDATE SET
  zone_id = EXCLUDED.zone_id,
  farm_id = EXCLUDED.farm_id,
  type = EXCLUDED.type,
  unit = EXCLUDED.unit,
  min_valid = EXCLUDED.min_valid,
  max_valid = EXCLUDED.max_valid,
  status = EXCLUDED.status;

-- 4 van tưới (1 van / zone)
INSERT INTO actuators (id, zone_id, farm_id, type, state, flow_rate_lpm)
VALUES
  ('valve-zone-A', 'zone-A', 'farm-01', 'valve', 'closed', 25.0),
  ('valve-zone-B', 'zone-B', 'farm-01', 'valve', 'closed', 30.0),
  ('valve-zone-C', 'zone-C', 'farm-01', 'valve', 'closed', 25.0),
  ('valve-zone-D', 'zone-D', 'farm-01', 'valve', 'closed', 20.0)
ON CONFLICT (id) DO UPDATE SET
  zone_id = EXCLUDED.zone_id,
  farm_id = EXCLUDED.farm_id,
  flow_rate_lpm = EXCLUDED.flow_rate_lpm;
