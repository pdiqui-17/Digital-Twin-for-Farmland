import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load root .env when running locally; in Docker/K8s env vars are injected directly
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    return ['true', '1', 'yes', 'on'].includes(val.trim().toLowerCase());
  });

const SimulatorConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3001),
  farmId: z.string().min(1).default('farm-01'),
  latitude: z.coerce.number().min(-90).max(90).default(11.9404),
  longitude: z.coerce.number().min(-180).max(180).default(108.4583),

  mqttBrokerUrl: z.string().min(1).default('mqtt://localhost:1883'),
  mqttUsername: z.string().optional(),
  mqttPassword: z.string().optional(),
  mqttClientIdPrefix: z.string().min(1).default('dtf-simulator'),

  zoneCount: z.coerce.number().int().min(1).max(26).default(4),
  virtualSensorsPerZone: z.coerce.number().int().min(0).max(5000).default(0),
  tickIntervalMs: z.coerce.number().int().min(200).max(300000).default(5000),
  /** Số phút vật lý mô phỏng trôi qua trong mỗi nhịp tick (giúp thấy rõ biến thiên trên demo) */
  physicsMinutesPerTick: z.coerce.number().positive().default(5),

  droughtMode: booleanFromEnv.default(false),
  weatherEnabled: booleanFromEnv.default(true),
  /** Tỷ lệ gửi đơn vị thay thế (vd °F, klux, %) để kiểm chứng bộ chuẩn hóa đơn vị của Processor */
  altUnitProbability: z.coerce.number().min(0).max(1).default(0.05),
  /** Xác suất lỗi ngẫu nhiên tức thời trên mỗi nhịp đọc (0 = chỉ lỗi khi tiêm chủ động) */
  randomFaultRate: z.coerce.number().min(0).max(0.5).default(0.005),
});

export type SimulatorConfig = z.infer<typeof SimulatorConfigSchema>;

export function loadSimulatorConfig(env: NodeJS.ProcessEnv = process.env): SimulatorConfig {
  return SimulatorConfigSchema.parse({
    port: env.PORT ?? env.SIMULATOR_PORT ?? 3001,
    farmId: env.SIMULATOR_FARM_ID ?? 'farm-01',
    latitude: env.SIMULATOR_LATITUDE ?? 11.9404,
    longitude: env.SIMULATOR_LONGITUDE ?? 108.4583,

    mqttBrokerUrl: env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mqttClientIdPrefix: env.SIMULATOR_MQTT_CLIENT_PREFIX ?? 'dtf-simulator',

    zoneCount: env.SIMULATOR_ZONE_COUNT ?? 4,
    virtualSensorsPerZone: env.SIMULATOR_VIRTUAL_SENSORS_PER_ZONE ?? 0,
    tickIntervalMs: env.SIMULATOR_TICK_INTERVAL_MS ?? 5000,
    physicsMinutesPerTick: env.SIMULATOR_PHYSICS_MINUTES_PER_TICK ?? 5,

    droughtMode: env.SIMULATOR_DROUGHT_MODE ?? false,
    weatherEnabled: env.SIMULATOR_WEATHER_ENABLED ?? true,
    altUnitProbability: env.SIMULATOR_ALT_UNIT_PROBABILITY ?? 0.05,
    randomFaultRate: env.SIMULATOR_RANDOM_FAULT_RATE ?? 0.005,
  });
}
