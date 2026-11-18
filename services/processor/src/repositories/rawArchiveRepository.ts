import crypto from 'node:crypto';
import * as Minio from 'minio';
import { Logger, RawTelemetryEnvelope } from '@digital-twin/shared';
import { ProcessorMetrics } from '../metrics';

export interface RawArchiveOptions {
  enabled: boolean;
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey?: string;
  bucketName: string;
  batchSize: number;
  flushIntervalMs: number;
}

export class RawArchiveRepository {
  private client: Minio.Client | null = null;
  private buffer: RawTelemetryEnvelope[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private ready = false;

  constructor(
    private readonly options: RawArchiveOptions,
    private readonly metrics: ProcessorMetrics,
    private readonly logger: Logger,
  ) {
    if (options.enabled && options.secretKey) {
      this.client = new Minio.Client({
        endPoint: options.endPoint,
        port: options.port,
        useSSL: options.useSSL,
        accessKey: options.accessKey,
        secretKey: options.secretKey,
      });
    }
  }

  async initialize(): Promise<void> {
    if (!this.options.enabled || !this.client) {
      this.ready = true;
      this.logger.info('MinIO cold archive disabled via config');
      return;
    }

    const exists = await this.client.bucketExists(this.options.bucketName);
    if (!exists) {
      await this.client.makeBucket(this.options.bucketName);
      this.logger.info('Created MinIO raw archive bucket', {
        bucket: this.options.bucketName,
      });
    } else {
      this.logger.info('Verified MinIO raw archive bucket', {
        bucket: this.options.bucketName,
      });
    }

    this.ready = true;
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  isReady(): boolean {
    return this.ready;
  }

  getBufferedCount(): number {
    return this.buffer.length;
  }

  enqueue(envelope: RawTelemetryEnvelope): void {
    if (!this.options.enabled || !this.client) return;
    this.buffer.push(envelope);
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.options.enabled || !this.client || this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    const batch = this.buffer.splice(0, this.options.batchSize * 2);

    try {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const hh = String(now.getUTCHours()).padStart(2, '0');
      const farmId = batch[0]?.farmId ?? 'unknown-farm';
      const shortId = crypto.randomBytes(4).toString('hex');

      const objectKey = `farm=${farmId}/date=${yyyy}-${mm}-${dd}/hour=${hh}/raw-${now.getTime()}-${shortId}.ndjson`;
      const ndjsonBody = `${batch.map((item) => JSON.stringify(item)).join('\n')}\n`;
      const payloadBuf = Buffer.from(ndjsonBody, 'utf8');

      await this.client.putObject(
        this.options.bucketName,
        objectKey,
        payloadBuf,
        payloadBuf.length,
        { 'Content-Type': 'application/x-ndjson' },
      );

      this.ready = true;
      this.metrics.minioBatchesUploadedTotal.inc();
      this.metrics.minioRecordsArchivedTotal.inc(batch.length);
    } catch (err) {
      this.ready = false;
      if (this.buffer.length < 5000) {
        this.buffer.unshift(...batch);
      }
      this.logger.warn('Failed to upload raw batch to MinIO', {
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
