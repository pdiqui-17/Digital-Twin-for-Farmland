import { createServiceRegistry, promClient } from '@digital-twin/shared';

export interface ProcessorMetrics {
  registry: ReturnType<typeof createServiceRegistry>;
  mqttMessagesReceivedTotal: promClient.Counter<'farm_id'>;
  rawKafkaProducedTotal: promClient.Counter;
  invalidMessagesTotal: promClient.Counter<'reason'>;
  cleanedMessagesTotal: promClient.Counter<'zone_id' | 'sensor_type' | 'quality'>;
  dbRowsInsertedTotal: promClient.Counter;
  minioBatchesUploadedTotal: promClient.Counter;
  minioRecordsArchivedTotal: promClient.Counter;
  pipelineEndToEndLatencySeconds: promClient.Histogram;
  dbFlushDurationSeconds: promClient.Histogram;
}

export function createProcessorMetrics(): ProcessorMetrics {
  const registry = createServiceRegistry('processor');

  const mqttMessagesReceivedTotal = new promClient.Counter({
    name: 'processor_mqtt_messages_received_total',
    help: 'Total raw sensor messages received from MQTT shared subscription',
    labelNames: ['farm_id'] as const,
    registers: [registry],
  });

  const rawKafkaProducedTotal = new promClient.Counter({
    name: 'processor_raw_kafka_produced_total',
    help: 'Total raw sensor envelopes pushed to Kafka topic telemetry.raw',
    registers: [registry],
  });

  const invalidMessagesTotal = new promClient.Counter({
    name: 'processor_invalid_messages_total',
    help: 'Total messages rejected due to malformed JSON, invalid schema, or incompatible unit',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  const cleanedMessagesTotal = new promClient.Counter({
    name: 'processor_cleaned_messages_total',
    help: 'Total processed telemetry records grouped by zone, sensor type, and data quality flag',
    labelNames: ['zone_id', 'sensor_type', 'quality'] as const,
    registers: [registry],
  });

  const dbRowsInsertedTotal = new promClient.Counter({
    name: 'processor_db_rows_inserted_total',
    help: 'Total sensor_readings rows inserted into TimescaleDB',
    registers: [registry],
  });

  const minioBatchesUploadedTotal = new promClient.Counter({
    name: 'processor_minio_batches_uploaded_total',
    help: 'Total NDJSON raw archive batches uploaded to MinIO cold storage',
    registers: [registry],
  });

  const minioRecordsArchivedTotal = new promClient.Counter({
    name: 'processor_minio_records_archived_total',
    help: 'Total raw telemetry envelopes archived into MinIO cold storage',
    registers: [registry],
  });

  const pipelineEndToEndLatencySeconds = new promClient.Histogram({
    name: 'processor_pipeline_end_to_end_latency_seconds',
    help: 'End-to-end latency from sensor timestamp (ts) to TimescaleDB persistence (seconds)',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const dbFlushDurationSeconds = new promClient.Histogram({
    name: 'processor_db_flush_duration_seconds',
    help: 'Duration of batch INSERT operations into TimescaleDB (seconds)',
    buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  });

  return {
    registry,
    mqttMessagesReceivedTotal,
    rawKafkaProducedTotal,
    invalidMessagesTotal,
    cleanedMessagesTotal,
    dbRowsInsertedTotal,
    minioBatchesUploadedTotal,
    minioRecordsArchivedTotal,
    pipelineEndToEndLatencySeconds,
    dbFlushDurationSeconds,
  };
}
