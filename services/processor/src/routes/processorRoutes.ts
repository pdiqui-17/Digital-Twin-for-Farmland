import { Router, Request, Response } from 'express';
import { TelemetryCleaner } from '../domain/telemetryCleaner';
import { KafkaTelemetryPipeline } from '../kafkaPipeline';
import { MqttIngestor } from '../mqttIngestor';
import { RawArchiveRepository } from '../repositories/rawArchiveRepository';
import { ReadingsRepository } from '../repositories/readingsRepository';

export interface ProcessorRouterDeps {
  mqttIngestor: MqttIngestor;
  kafkaPipeline: KafkaTelemetryPipeline;
  readingsRepo: ReadingsRepository;
  archiveRepo: RawArchiveRepository;
  cleaner: TelemetryCleaner;
}

export function createProcessorRouter(deps: ProcessorRouterDeps): Router {
  const { mqttIngestor, kafkaPipeline, readingsRepo, archiveRepo, cleaner } = deps;
  const router = Router();

  router.get('/processor/status', (_req: Request, res: Response) => {
    res.status(200).json({
      mqttConnected: mqttIngestor.isConnected(),
      kafkaReady: kafkaPipeline.isReady(),
      timescaleHealthy: readingsRepo.isHealthy(),
      minioReady: archiveRepo.isReady(),
      trackedSensors: cleaner.getTrackedSensorCount(),
      buffers: {
        pendingDbRows: readingsRepo.getBufferedCount(),
        pendingMinioRecords: archiveRepo.getBufferedCount(),
      },
    });
  });

  router.post('/processor/flush', async (_req: Request, res: Response) => {
    await Promise.all([readingsRepo.flush(), archiveRepo.flush()]);
    res.status(200).json({
      flushed: true,
      buffers: {
        pendingDbRows: readingsRepo.getBufferedCount(),
        pendingMinioRecords: archiveRepo.getBufferedCount(),
      },
    });
  });

  return router;
}
