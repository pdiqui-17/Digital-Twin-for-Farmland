-- ============================================================================
-- Migration 005: Vòng đời cảnh báo cho Controller (Role B đề xuất, Role A duyệt)
--
-- Bổ sung cho bảng alerts của migration 003 (không đổi cột cũ):
--   - rule      : luật sinh cảnh báo (soil_dry, soil_critical, zone_unknown, sensor_fault, fungal_risk, valve_ack_timeout)
--   - closed_at : thời điểm sự cố kết thúc; NULL = cảnh báo đang mở. Cột ts giữ nghĩa "lúc mở".
-- Mỗi vòng đời cảnh báo là MỘT dòng: Controller chèn khi mở, cập nhật closed_at khi đóng.
--
-- Quyền ghi đề xuất: chỉ Controller ghi bảng alerts (một bảng một writer, project_assigning.md mục 3.3).
-- Twin Service không ghi alerts; nó đưa cờ chất lượng cảm biến vào twin_state.state.faultySensors
-- để Controller sinh cảnh báo sensor_fault.
-- ============================================================================

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Controller khôi phục các cảnh báo đang mở khi khởi động lại.
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (zone_id, rule) WHERE closed_at IS NULL;

-- Controller khôi phục pha van từ lệnh gần nhất của mỗi zone (đã có idx_commands_zone_ts ở 003).
