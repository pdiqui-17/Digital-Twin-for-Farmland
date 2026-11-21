import { z } from 'zod';

// ============================================================================
// 1. Enums & Hằng số chuẩn hóa cho Cảm biến, Đơn vị và Chất lượng dữ liệu
// ============================================================================

export const SensorTypeSchema = z.enum([
  'soil_moisture',
  'air_temperature',
  'air_humidity',
  'light_intensity',
]);
export type SensorType = z.infer<typeof SensorTypeSchema>;

export const CanonicalUnitSchema = z.enum(['percent', 'celsius', 'lux']);
export type CanonicalUnit = z.infer<typeof CanonicalUnitSchema>;

export const DataQualitySchema = z.enum([
  'ok',
  'noisy_smoothed',
  'out_of_range',
  'stuck',
  'missing_signal',
]);
export type DataQuality = z.infer<typeof DataQualitySchema>;

export interface SensorSpec {
  canonicalUnit: CanonicalUnit;
  minValid: number;
  maxValid: number;
}

/**
 * Ngưỡng vật lý hợp lệ và đơn vị chuẩn cho từng loại cảm biến.
 * Dùng chung cho cả Simulator (sinh dữ liệu/lỗi) và Processor (kiểm định/lọc nhiễu).
 */
export const SENSOR_SPECS: Record<SensorType, SensorSpec> = {
  soil_moisture: {
    canonicalUnit: 'percent',
    minValid: 0,
    maxValid: 100,
  },
  air_temperature: {
    canonicalUnit: 'celsius',
    minValid: -10,
    maxValid: 60,
  },
  air_humidity: {
    canonicalUnit: 'percent',
    minValid: 0,
    maxValid: 100,
  },
  light_intensity: {
    canonicalUnit: 'lux',
    minValid: 0,
    maxValid: 150000,
  },
};

// ============================================================================
// 2. Thực thể danh mục (Farm, Zone, Sensor, Actuator)
// ============================================================================

export const FarmSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  areaHectares: z.number().positive(),
  createdAt: z.string().datetime({ offset: true }).optional(),
});
export type Farm = z.infer<typeof FarmSchema>;

export const ZoneSchema = z.object({
  id: z.string().min(1),
  farmId: z.string().min(1),
  name: z.string().min(1),
  cropType: z.string().min(1),
  soilType: z.enum(['sandy', 'loam', 'clay']).default('loam'),
  areaSqm: z.number().positive(),
  moistureOptimalMin: z.number().min(0).max(100),
  moistureOptimalMax: z.number().min(0).max(100),
  createdAt: z.string().datetime({ offset: true }).optional(),
});
export type Zone = z.infer<typeof ZoneSchema>;

export const SensorStatusSchema = z.enum(['active', 'faulty', 'offline']);
export type SensorStatus = z.infer<typeof SensorStatusSchema>;

export const SensorSchema = z.object({
  id: z.string().min(1),
  zoneId: z.string().min(1),
  farmId: z.string().min(1),
  type: SensorTypeSchema,
  unit: CanonicalUnitSchema,
  minValid: z.number(),
  maxValid: z.number(),
  status: SensorStatusSchema.default('active'),
  createdAt: z.string().datetime({ offset: true }).optional(),
});
export type Sensor = z.infer<typeof SensorSchema>;

export const ValveStateValueSchema = z.enum(['open', 'closed']);
export type ValveStateValue = z.infer<typeof ValveStateValueSchema>;

export const ActuatorSchema = z.object({
  id: z.string().min(1),
  zoneId: z.string().min(1),
  farmId: z.string().min(1),
  type: z.literal('valve'),
  state: ValveStateValueSchema,
  flowRateLitersPerMin: z.number().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export type Actuator = z.infer<typeof ActuatorSchema>;

// ============================================================================
// 3. Schema Message Telemetry (MQTT -> Kafka Raw -> Kafka Clean)
// ============================================================================

/**
 * Payload cảm biến gửi qua MQTT (khớp mục 3.4 trong project_assigning.md).
 * Cho phép unit dạng chuỗi thô (vd: "%", "percent", "C", "F", "lux", "klux")
 * để Processor chuẩn hóa về CanonicalUnit.
 */
export const SensorTelemetryMessageSchema = z.object({
  sensorId: z.string().min(1),
  zoneId: z.string().min(1),
  farmId: z.string().min(1).optional(),
  type: SensorTypeSchema,
  value: z.number().finite(),
  unit: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  quality: DataQualitySchema.default('ok'),
});
export type SensorTelemetryMessage = z.infer<typeof SensorTelemetryMessageSchema>;

/**
 * Gói tin đẩy vào Kafka topic `telemetry.raw` từ tầng MQTT Bridge của Processor.
 * Lưu nguyên bản rawPayload (dạng string hoặc object) kèm metadata thu nhận.
 */
export const RawTelemetryEnvelopeSchema = z.object({
  mqttTopic: z.string().min(1),
  farmId: z.string().min(1),
  zoneId: z.string().min(1),
  sensorId: z.string().min(1),
  receivedAt: z.string().datetime({ offset: true }),
  rawPayload: z.string(),
});
export type RawTelemetryEnvelope = z.infer<typeof RawTelemetryEnvelopeSchema>;

/**
 * Gói tin sạch đẩy vào Kafka topic `telemetry.clean` và ghi vào bảng `sensor_readings`.
 */
export const CleanTelemetryMessageSchema = z.object({
  farmId: z.string().min(1),
  zoneId: z.string().min(1),
  sensorId: z.string().min(1),
  type: SensorTypeSchema,
  value: z.number().finite(),
  rawValue: z.number().finite().optional(),
  unit: CanonicalUnitSchema,
  ts: z.string().datetime({ offset: true }),
  ingestedAt: z.string().datetime({ offset: true }),
  quality: DataQualitySchema,
});
export type CleanTelemetryMessage = z.infer<typeof CleanTelemetryMessageSchema>;

// ============================================================================
// 4. Schema Điều khiển Van tưới (Actuator Command & State) và Cảnh báo (Alerts)
// ============================================================================

export const ValveActionSchema = z.enum(['open', 'close']);
export type ValveAction = z.infer<typeof ValveActionSchema>;

/**
 * Lệnh điều khiển gửi tới `farm/{farmId}/zone/{zoneId}/actuator/valve/cmd`
 */
export const ValveCommandMessageSchema = z.object({
  commandId: z.string().min(1),
  farmId: z.string().min(1),
  zoneId: z.string().min(1),
  actuatorId: z.string().min(1).optional(),
  action: ValveActionSchema,
  /** Thời gian mở van tự động đóng (giây), dùng khi action === 'open' */
  durationSec: z.number().int().positive().optional(),
  reason: z.string().optional(),
  issuedBy: z.string().default('controller'),
  ts: z.string().datetime({ offset: true }),
});
export type ValveCommandMessage = z.infer<typeof ValveCommandMessageSchema>;

/**
 * Phản hồi trạng thái van tại `farm/{farmId}/zone/{zoneId}/actuator/valve/state`
 */
export const ValveStateMessageSchema = z.object({
  farmId: z.string().min(1),
  zoneId: z.string().min(1),
  actuatorId: z.string().min(1),
  state: ValveStateValueSchema,
  lastCommandId: z.string().optional(),
  flowRateLitersPerMin: z.number().nonnegative(),
  ts: z.string().datetime({ offset: true }),
});
export type ValveStateMessage = z.infer<typeof ValveStateMessageSchema>;

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

/**
 * Sự kiện cảnh báo trên Kafka topic `alerts` (Role B sử dụng chính)
 */
export const AlertEventSchema = z.object({
  alertId: z.string().min(1),
  farmId: z.string().min(1),
  zoneId: z.string().min(1),
  severity: AlertSeveritySchema,
  category: z.enum(['drought', 'water_stress', 'fungal_risk', 'sensor_fault', 'system']),
  message: z.string().min(1),
  ts: z.string().datetime({ offset: true }),
  metadata: z.record(z.unknown()).optional(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;
