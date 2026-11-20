import { z } from "zod";

export const SENSOR_TYPES = [
  "soil_moisture",
  "soil_temp",
  "air_temp",
  "air_humidity",
  "rain",
  "leaf_wetness",
] as const;
export const SensorType = z.enum(SENSOR_TYPES);
export type SensorType = z.infer<typeof SensorType>;

export const Quality = z.enum(["ok", "suspect", "bad"]);
export type Quality = z.infer<typeof Quality>;

const isoTs = z.string().datetime({ offset: true });

/** Message trên telemetry.clean và MQTT telemetry (mục 3.4 tài liệu gốc). */
export const Reading = z.object({
  sensorId: z.string().min(1),
  zoneId: z.string().min(1),
  farmId: z.string().min(1).optional(),
  type: SensorType,
  value: z.number().finite(),
  unit: z.string().min(1),
  ts: isoTs,
  quality: Quality.default("ok"),
});
export type Reading = z.infer<typeof Reading>;

export const ZoneStatus = z.enum(["ok", "dry", "critical", "unknown"]);
export type ZoneStatus = z.infer<typeof ZoneStatus>;

export const SensorSnapshot = z.object({
  type: SensorType,
  value: z.number(),
  unit: z.string(),
  ts: isoTs,
  quality: Quality,
});
export type SensorSnapshot = z.infer<typeof SensorSnapshot>;

export const ValveMode = z.enum(["open", "closed", "unknown"]);
export type ValveMode = z.infer<typeof ValveMode>;

/** Phản hồi trạng thái van từ simulator/actuator. */
export const ValveStateMsg = z.object({
  zoneId: z.string(),
  state: ValveMode,
  commandId: z.string().optional(),
  ts: isoTs,
});
export type ValveStateMsg = z.infer<typeof ValveStateMsg>;

export const Command = z.object({
  commandId: z.string(),
  zoneId: z.string(),
  farmId: z.string().optional(),
  action: z.enum(["open", "close"]),
  durationSec: z.number().int().positive().optional(),
  reason: z.string(),
  ts: isoTs,
});
export type Command = z.infer<typeof Command>;

export const ZoneState = z.object({
  zoneId: z.string(),
  farmId: z.string(),
  updatedAt: isoTs,
  lastDataAt: isoTs.nullable(),
  sensors: z.record(SensorSnapshot),
  metrics: z.object({
    soilMoisture: z.number().nullable(),
    soilTemp: z.number().nullable(),
    airTemp: z.number().nullable(),
    airHumidity: z.number().nullable(),
    rain: z.number().nullable(),
  }),
  derived: z.object({
    waterStress: z.number().min(0).max(1).nullable(),
    fungalRisk: z.number().min(0).max(1),
    fungalAccumMin: z.number().min(0),
  }),
  valve: z.object({ state: ValveMode, ts: isoTs.nullable() }),
  status: ZoneStatus,
});
export type ZoneState = z.infer<typeof ZoneState>;

export const Severity = z.enum(["info", "warning", "critical"]);
export type Severity = z.infer<typeof Severity>;

/** Sự kiện trên topic Kafka `alerts`. */
export const AlertEvent = z.object({
  alertId: z.string(),
  zoneId: z.string(),
  rule: z.string(),
  severity: Severity,
  state: z.enum(["open", "closed"]),
  message: z.string(),
  value: z.number().nullable(),
  ts: isoTs,
});
export type AlertEvent = z.infer<typeof AlertEvent>;
