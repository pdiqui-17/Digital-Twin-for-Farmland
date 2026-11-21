import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((val) => {
    if (typeof val === 'boolean') return val;
    return ['true', '1', 'yes', 'on'].includes(val.trim().toLowerCase());
  });

const ProcessorConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3002),

  mqttBrokerUrl: z.string().min(1).default('mqtt://localhost:1883'),
  mqttUsername: z.string().optional(),
  mqttPassword: z.string().optional(),
  mqttSharedGroup: z.string().min(1).default('processor-bridge'),

  kafkaBrokers: z
    .string()
    .min(1)
    .default('localhost:9092')
    .transform((s) => s.split(',').map((b) => b.trim()).filter(Boolean)),
  kafkaClientId: z.string().min(1).default('dtf-processor'),
  kafkaConsumerGroup: z.string().min(1).default('processor-telemetry-group'),
  kafkaTopicPartitions: z.coerce.number().int().min(1).max(32).default(4),

  pgHost: z.string().min(1).default('localhost'),
  pgPort: z.coerce.number().int().positive().default(5432),
  pgDatabase: z.string().min(1).default('digital_twin_farm'),
  pgUser: z.string().min(1).default('twin_user'),
  pgPassword: z.string().min(1),
  pgPoolMax: z.coerce.number().int().min(2).max(50).default(10),

  dbBatchSize: z.coerce.number().int().min(1).max(1000).default(50),
  dbFlushIntervalMs: z.coerce.number().int().min(100).max(30000).default(1000),

  minioEnabled: booleanFromEnv.default(true),
  minioEndpoint: z.string().min(1).default('localhost'),
  minioPort: z.coerce.number().int().positive().default(9000),
  minioUseSsl: booleanFromEnv.default(false),
  minioAccessKey: z.string().min(1).default('minio_admin'),
  minioSecretKey: z.string().optional(),
  minioRawBucket: z.string().min(1).default('telemetry-raw'),
  archiveBatchSize: z.coerce.number().int().min(1).max(5000).default(100),
  archiveFlushIntervalMs: z.coerce.number().int().min(1000).max(300000).default(10000),

  stuckThresholdCount: z.coerce.number().int().min(3).max(100).default(5),
  missingSignalTimeoutMs: z.coerce.number().int().min(5000).max(600000).default(20000),
});

export type ProcessorConfig = z.infer<typeof ProcessorConfigSchema>;

export function loadProcessorConfig(env: NodeJS.ProcessEnv = process.env): ProcessorConfig {
  const parsed = ProcessorConfigSchema.parse({
    port: env.PORT ?? env.PROCESSOR_PORT ?? 3002,

    mqttBrokerUrl: env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883',
    mqttUsername: env.MQTT_USERNAME || undefined,
    mqttPassword: env.MQTT_PASSWORD || undefined,
    mqttSharedGroup: env.PROCESSOR_MQTT_SHARED_GROUP ?? 'processor-bridge',

    kafkaBrokers: env.KAFKA_BROKERS ?? 'localhost:9092',
    kafkaClientId: env.KAFKA_CLIENT_ID ?? 'dtf-processor',
    kafkaConsumerGroup: env.PROCESSOR_CONSUMER_GROUP ?? 'processor-telemetry-group',
    kafkaTopicPartitions: env.PROCESSOR_KAFKA_PARTITIONS ?? 4,

    pgHost: env.POSTGRES_HOST ?? 'localhost',
    pgPort: env.POSTGRES_PORT ?? 5432,
    pgDatabase: env.POSTGRES_DB ?? 'digital_twin_farm',
    pgUser: env.POSTGRES_USER ?? 'twin_user',
    pgPassword: env.POSTGRES_PASSWORD,
    pgPoolMax: env.PROCESSOR_PG_POOL_MAX ?? 10,

    dbBatchSize: env.PROCESSOR_BATCH_SIZE ?? 50,
    dbFlushIntervalMs: env.PROCESSOR_FLUSH_INTERVAL_MS ?? 1000,

    minioEnabled: env.PROCESSOR_MINIO_ENABLED ?? true,
    minioEndpoint: env.MINIO_ENDPOINT ?? 'localhost',
    minioPort: env.MINIO_PORT ?? 9000,
    minioUseSsl: env.MINIO_USE_SSL ?? false,
    minioAccessKey: env.MINIO_ROOT_USER ?? 'minio_admin',
    minioSecretKey: env.MINIO_ROOT_PASSWORD,
    minioRawBucket: env.MINIO_RAW_BUCKET ?? 'telemetry-raw',
    archiveBatchSize: env.PROCESSOR_ARCHIVE_BATCH_SIZE ?? 100,
    archiveFlushIntervalMs: env.PROCESSOR_ARCHIVE_FLUSH_INTERVAL_MS ?? 10000,

    stuckThresholdCount: env.PROCESSOR_STUCK_THRESHOLD_COUNT ?? 5,
    missingSignalTimeoutMs: env.PROCESSOR_MISSING_SIGNAL_TIMEOUT_MS ?? 20000,
  });

  if (parsed.minioEnabled && !parsed.minioSecretKey) {
    throw new Error('PROCESSOR_MINIO_ENABLED=true requires MINIO_ROOT_PASSWORD to be set');
  }

  return parsed;
}
