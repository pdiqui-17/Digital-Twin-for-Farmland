import { Pool } from 'pg';
import { CleanTelemetryMessage, Logger } from '@digital-twin/shared';
import { ProcessorMetrics } from '../metrics';

export interface ReadingsRepositoryOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxPoolSize: number;
  batchSize: number;
  flushIntervalMs: number;
}

export class ReadingsRepository {
  private readonly pool: Pool;
  private buffer: CleanTelemetryMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private healthy = false;

  constructor(
    private readonly options: ReadingsRepositoryOptions,
    private readonly metrics: ProcessorMetrics,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      max: options.maxPoolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    this.pool.on('error', (err) => {
      this.healthy = false;
      this.logger.error('Unexpected PostgreSQL pool error', { error: err.message });
    });
  }

  async initialize(): Promise<void> {
    await this.pool.query('SELECT 1');
    this.healthy = true;
    this.logger.info('Connected to TimescaleDB', {
      host: this.options.host,
      port: this.options.port,
      database: this.options.database,
    });

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getBufferedCount(): number {
    return this.buffer.length;
  }

  enqueue(record: CleanTelemetryMessage): void {
    this.buffer.push(record);
    if (this.buffer.length >= this.options.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) {
      return;
    }

    this.flushing = true;
    const batch = this.buffer.splice(0, this.options.batchSize * 2);
    const stopTimer = this.metrics.dbFlushDurationSeconds.startTimer();

    try {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        const base = i * 10;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
        );
        values.push(
          r.ts,
          r.ingestedAt,
          r.farmId,
          r.zoneId,
          r.sensorId,
          r.type,
          r.value,
          r.rawValue ?? null,
          r.unit,
          r.quality,
        );
      }

      const sql = `
        INSERT INTO sensor_readings (
          ts, ingested_at, farm_id, zone_id, sensor_id,
          sensor_type, value, raw_value, unit, quality
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (zone_id, sensor_id, ts) DO NOTHING
      `;

      const result = await this.pool.query(sql, values);
      this.healthy = true;

      const inserted = result.rowCount ?? batch.length;
      this.metrics.dbRowsInsertedTotal.inc(inserted);

      const persistedMs = Date.now();
      for (const r of batch) {
        const sensorTsMs = Date.parse(r.ts);
        if (!Number.isNaN(sensorTsMs) && persistedMs >= sensorTsMs) {
          this.metrics.pipelineEndToEndLatencySeconds.observe((persistedMs - sensorTsMs) / 1000);
        }
      }
    } catch (err) {
      this.healthy = false;
      // Đưa lại vào đầu buffer (giới hạn tối đa 5000 bản ghi để tránh tràn RAM nếu DB đứt lâu)
      if (this.buffer.length < 5000) {
        this.buffer.unshift(...batch);
      }
      this.logger.error('Failed to flush sensor_readings batch to TimescaleDB', {
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      stopTimer();
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    await this.pool.end();
  }
}
