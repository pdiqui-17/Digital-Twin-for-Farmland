import { Router, Request, Response } from 'express';
import client, { Registry } from 'prom-client';

export interface ReadinessCheckResult {
  ready: boolean;
  details?: Record<string, boolean | string>;
}

export interface ObservabilityOptions {
  serviceName: string;
  registry: Registry;
  /** Hàm kiểm tra kết nối hạ tầng (MQTT, Kafka, DB, MinIO...) cho /readyz */
  checkReady?: () => Promise<ReadinessCheckResult> | ReadinessCheckResult;
}

/**
 * Khởi tạo Prometheus Registry riêng cho một service, gắn sẵn nhãn `service`
 * và thu thập metrics mặc định của tiến trình Node.js.
 */
export function createServiceRegistry(serviceName: string): Registry {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register: registry });
  return registry;
}

/**
 * Tạo Express Router cung cấp 3 endpoints bắt buộc cho mọi microservice trên K8s:
 * - GET /healthz (Liveness probe)
 * - GET /readyz  (Readiness probe)
 * - GET /metrics (Prometheus scrape endpoint)
 */
export function createObservabilityRouter(options: ObservabilityOptions): Router {
  const { serviceName, registry, checkReady } = options;
  const router = Router();

  router.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: serviceName,
      ts: new Date().toISOString(),
    });
  });

  router.get('/readyz', async (_req: Request, res: Response) => {
    try {
      if (!checkReady) {
        res.status(200).json({
          ready: true,
          service: serviceName,
          ts: new Date().toISOString(),
        });
        return;
      }

      const result = await checkReady();
      const statusCode = result.ready ? 200 : 503;
      res.status(statusCode).json({
        ready: result.ready,
        service: serviceName,
        details: result.details ?? {},
        ts: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        ready: false,
        service: serviceName,
        error: err instanceof Error ? err.message : 'Unknown readiness error',
        ts: new Date().toISOString(),
      });
    }
  });

  router.get('/metrics', async (_req: Request, res: Response) => {
    try {
      res.set('Content-Type', registry.contentType);
      const metricsOutput = await registry.metrics();
      res.status(200).end(metricsOutput);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to collect metrics',
      });
    }
  });

  return router;
}

export { client as promClient };
