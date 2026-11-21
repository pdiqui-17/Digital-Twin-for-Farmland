import { z } from 'zod';
import { AlertEventSchema, DataQualitySchema, SensorTypeSchema, type DataQuality } from './schemas';

/**
 * Hợp đồng của Role B (Twin Core): trạng thái twin theo zone, ngưỡng nghiệp vụ, vòng đời cảnh báo.
 * Chỉ BỔ SUNG, không sửa schema của Role A trong schemas.ts.
 */

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

// ============================================================================
// Tỉ lệ thời gian mô phỏng
// ============================================================================

/** Mặc định của simulator (Role A): mỗi tick 5 s thật chạy 5 phút vật lý, tức nhanh 60 lần. */
export const SIMULATOR_DEFAULT_TICK_MS = 5000;
export const SIMULATOR_DEFAULT_PHYSICS_MINUTES = 5;

/**
 * Số giây "ruộng" trôi qua trong 1 giây thật.
 * Ưu tiên SIM_TIME_SCALE (nông trại thật: 1); nếu không thì suy từ chính biến cấu hình của simulator,
 * dùng mặc định của simulator khi biến không được đặt. Giá trị không hợp lệ thì trả 1.
 */
export function simTimeScale(env: Record<string, string | undefined>): number {
  const explicit = Number(env.SIM_TIME_SCALE);
  if (env.SIM_TIME_SCALE && Number.isFinite(explicit) && explicit > 0) return explicit;
  const tickMs = Number(env.SIMULATOR_TICK_INTERVAL_MS || SIMULATOR_DEFAULT_TICK_MS);
  const physicsMin = Number(env.SIMULATOR_PHYSICS_MINUTES_PER_TICK || SIMULATOR_DEFAULT_PHYSICS_MINUTES);
  const scale = (physicsMin * 60_000) / tickMs;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Chất lượng dùng được cho giá trị nghiệp vụ (tài liệu bàn giao Role A, mục 3.1). */
export const USABLE_QUALITIES: readonly DataQuality[] = ['ok', 'noisy_smoothed'];
export const isUsableQuality = (q: DataQuality): boolean => USABLE_QUALITIES.includes(q);

// ============================================================================
// Ngưỡng nghiệp vụ theo zone
// ============================================================================

export const ThresholdsSchema = z.object({
  /** Cận dưới / cận trên khoảng ẩm tối ưu (zones.moisture_optimal_min/max). */
  optimalLow: z.number(),
  optimalHigh: z.number(),
  /** status = dry khi độ ẩm < dryBelow. */
  dryBelow: z.number(),
  /** status = critical khi độ ẩm < criticalBelow. */
  criticalBelow: z.number(),
  /** Điểm héo: dưới mức này stress nước = 1. */
  wiltingPoint: z.number(),
  /** Sức chứa ruộng: mô hình Analytics không cho độ ẩm vượt quá mức này. */
  fieldCapacity: z.number(),
  /** Không có dữ liệu quá thời gian này (giây) thì sensor bị coi là cũ. */
  staleAfterSec: z.number().positive(),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

/**
 * Suy ra ngưỡng từ khoảng ẩm tối ưu của zone.
 * dry = dưới khoảng tối ưu; critical = thấp hơn 10 điểm %; điểm héo = thấp hơn 20 điểm %.
 */
export function deriveThresholds(optimalMin: number, optimalMax: number, staleAfterSec = 300): Thresholds {
  return {
    optimalLow: optimalMin,
    optimalHigh: optimalMax,
    dryBelow: optimalMin,
    criticalBelow: Math.max(0, optimalMin - 10),
    wiltingPoint: Math.max(0, optimalMin - 20),
    fieldCapacity: Math.min(100, optimalMax + 10),
    staleAfterSec,
  };
}

/** Dùng khi zone chưa có trong danh mục (khớp khoảng tối ưu phổ biến trong seed). */
export const DEFAULT_THRESHOLDS: Thresholds = deriveThresholds(45, 70);

// ============================================================================
// Trạng thái twin của một zone (cột twin_state.state JSONB)
// ============================================================================

export const ZoneStatusSchema = z.enum(['ok', 'dry', 'critical', 'unknown']);
export type ZoneStatus = z.infer<typeof ZoneStatusSchema>;

const isoTs = z.string().datetime({ offset: true });

export const SensorSnapshotSchema = z.object({
  type: SensorTypeSchema,
  value: z.number(),
  unit: z.string(),
  ts: isoTs,
  quality: DataQualitySchema,
});
export type SensorSnapshot = z.infer<typeof SensorSnapshotSchema>;

export const TwinValveStateSchema = z.enum(['open', 'closed', 'unknown']);
export type TwinValveState = z.infer<typeof TwinValveStateSchema>;

export const ZoneStateSchema = z.object({
  zoneId: z.string(),
  farmId: z.string(),
  updatedAt: isoTs,
  lastDataAt: isoTs.nullable(),
  sensors: z.record(SensorSnapshotSchema),
  metrics: z.object({
    soilMoisture: z.number().nullable(),
    airTemperature: z.number().nullable(),
    airHumidity: z.number().nullable(),
    lightIntensity: z.number().nullable(),
  }),
  derived: z.object({
    waterStress: z.number().min(0).max(1).nullable(),
    fungalRisk: z.number().min(0).max(1),
    fungalAccumMin: z.number().min(0),
  }),
  /** Sensor còn "tươi" nhưng bản tin mới nhất bị gắn cờ lỗi (out_of_range, stuck, missing_signal). */
  faultySensors: z.array(z.string()),
  valve: z.object({ state: TwinValveStateSchema, ts: isoTs.nullable(), lastCommandId: z.string().optional() }),
  thresholds: ThresholdsSchema,
  status: ZoneStatusSchema,
});
export type ZoneState = z.infer<typeof ZoneStateSchema>;

// ============================================================================
// Sự kiện cảnh báo có vòng đời (mở rộng AlertEventSchema của Role A)
// ============================================================================

/**
 * Tương thích ngược với AlertEventSchema: consumer chỉ biết schema của A vẫn parse được,
 * các trường thêm (rule, state, value) bị bỏ qua.
 */
export const TwinAlertEventSchema = AlertEventSchema.extend({
  /** Luật sinh cảnh báo, ví dụ soil_dry, sensor_fault. */
  rule: z.string().min(1),
  /** open = bắt đầu sự cố, closed = đã hết (hysteresis). Cùng alertId cho cả vòng đời. */
  state: z.enum(['open', 'closed']),
  value: z.number().nullable(),
});
export type TwinAlertEvent = z.infer<typeof TwinAlertEventSchema>;
