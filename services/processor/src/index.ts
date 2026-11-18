import express from 'express';
import { createLogger, createObservabilityRouter } from '@digital-twin/shared';
import { loadProcessorConfig } from './config';
import { TelemetryCleaner } from './domain/telemetryCleaner';
import { KafkaTelemetryPipeline } from './kafkaPipeline';
import { createProcessorMetrics } from './metrics';
import { MqttIngestor } from './mqttIngestor';
import { RawArchiveRepository } from './repositories/rawArchiveRepository';
import { ReadingsRepository } from './repositories/readingsRepository';
import { createProcessorRouter } from './routes/processorRoutes';

async function bootstrap(): Promise<void> {
  const config = loadProcessorConfig();
  const logger = createLogger('processor');
  const metrics = createProcessorMetrics();

  const cleaner = new TelemetryCleaner({
    stuckThresholdCount: config.stuckThresholdCount,
    missingSignalTimeoutMs: config.missingSignalTimeoutMs,
  });

  const readingsRepo = new ReadingsRepository(
    {
      host: config.pgHost,
      port: config.pgPort,
      database: config.pgDatabase,
      user: config.pgUser,
      password: config.pgPassword,
      maxPoolSize: config.pgPoolMax,
      batchSize: config.dbBatchSize,
      flushIntervalMs: config.dbFlushIntervalMs,
    },
    metrics,
    logger,
  );
  await readingsRepo.initialize();

  const archiveRepo = new RawArchiveRepository(
    {
      enabled: config.minioEnabled,
      endPoint: config.minioEndpoint,
      port: config.minioPort,
      useSSL: config.minioUseSsl,
      accessKey: config.minioAccessKey,
      secretKey: config.minioSecretKey,
      bucketName: config.minioRawBucket,
      batchSize: config.archiveBatchSize,
      flushIntervalMs: config.archiveFlushIntervalMs,
    },
    metrics,
    logger,
  );
  await archiveRepo.initialize();

  const kafkaPipeline = new KafkaTelemetryPipeline(
    {
      brokers: config.kafkaBrokers,
      clientId: config.kafkaClientId,
      consumerGroup: config.kafkaConsumerGroup,
      topicPartitions: config.kafkaTopicPartitions,
    },
    cleaner,
    readingsRepo,
    archiveRepo,
    metrics,
    logger,
  );
  await kafkaPipeline.start();

  const mqttIngestor = new MqttIngestor(
    {
      brokerUrl: config.mqttBrokerUrl,
      username: config.mqttUsername,
      password: config.mqttPassword,
      sharedGroup: config.mqttSharedGroup,
    },
    (envelope) => kafkaPipeline.publishRawEnvelope(envelope),
    metrics,
    logger,
  );
  await mqttIngestor.start();

  // Bộ canh thời gian (Watchdog) kiểm tra các cảm biến mất kết nối định kỳ mỗi 5 giây
  const watchdogTimer = setInterval(() => {
    const missingAlerts = cleaner.detectMissingSignals(Date.now());
    for (const alert of missingAlerts) {
      logger.warn('Detected missing sensor signal', {
        sensorId: alert.sensorId,
        zoneId: alert.zoneId,
      });
      void kafkaPipeline.emitCleanTelemetry(alert).catch((err) => {
        logger.error('Failed to emit missing_signal telemetry', {
          sensorId: alert.sensorId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }, 5000);

  const app = express();
  app.use(express.json());
  app.use(
    createObservabilityRouter({
      serviceName: 'processor',
      registry: metrics.registry,
      checkReady: () => {
        const mqttOk = mqttIngestor.isConnected();
        const kafkaOk = kafkaPipeline.isReady();
        const dbOk = readingsRepo.isHealthy();
        const minioOk = archiveRepo.isReady();
        return {
          ready: mqttOk && kafkaOk && dbOk && minioOk,
          details: {
            mqttConnected: mqttOk,
            kafkaReady: kafkaOk,
            timescaleHealthy: dbOk,
            minioReady: minioOk,
          },
        };
      },
    }),
  );
  app.use(
    createProcessorRouter({
      mqttIngestor,
      kafkaPipeline,
      readingsRepo,
      archiveRepo,
      cleaner,
    }),
  );

  const server = app.listen(config.port, () => {
    logger.info('Processor service started', {
      port: config.port,
      kafkaBrokers: config.kafkaBrokers,
      consumerGroup: config.kafkaConsumerGroup,
      minioEnabled: config.minioEnabled,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, flushing buffers and shutting down processor...`);
    clearInterval(watchdogTimer);
    server.close();
    await mqttIngestor.stop();
    await kafkaPipeline.stop();
    await Promise.all([readingsRepo.close(), archiveRepo.close()]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  process.stderr.write(`Fatal processor startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
