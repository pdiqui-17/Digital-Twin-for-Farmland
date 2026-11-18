import { Consumer, Kafka, logLevel, Partitioners, Producer } from 'kafkajs';
import {
  CleanTelemetryMessage,
  KAFKA_TOPICS,
  Logger,
  RawTelemetryEnvelope,
  RawTelemetryEnvelopeSchema,
} from '@digital-twin/shared';
import { TelemetryCleaner } from './domain/telemetryCleaner';
import { ProcessorMetrics } from './metrics';
import { RawArchiveRepository } from './repositories/rawArchiveRepository';
import { ReadingsRepository } from './repositories/readingsRepository';

export interface KafkaPipelineOptions {
  brokers: string[];
  clientId: string;
  consumerGroup: string;
  topicPartitions: number;
}

export class KafkaTelemetryPipeline {
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly consumer: Consumer;
  private ready = false;

  constructor(
    private readonly options: KafkaPipelineOptions,
    private readonly cleaner: TelemetryCleaner,
    private readonly readingsRepo: ReadingsRepository,
    private readonly archiveRepo: RawArchiveRepository,
    private readonly metrics: ProcessorMetrics,
    private readonly logger: Logger,
  ) {
    this.kafka = new Kafka({
      clientId: options.clientId,
      brokers: options.brokers,
      logLevel: logLevel.WARN,
    });

    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
    });

    this.consumer = this.kafka.consumer({
      groupId: options.consumerGroup,
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    await this.ensureTopics();
    await this.producer.connect();
    await this.consumer.connect();

    await this.consumer.subscribe({
      topic: KAFKA_TOPICS.TELEMETRY_RAW,
      fromBeginning: false,
    });

    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        await this.handleRawKafkaMessage(message.value.toString('utf8'));
      },
    });

    this.ready = true;
    this.logger.info('Kafka telemetry pipeline started', {
      brokers: this.options.brokers,
      consumerGroup: this.options.consumerGroup,
    });
  }

  /**
   * Đẩy gói tin thô từ MQTT vào Kafka topic `telemetry.raw` (partition theo zoneId).
   */
  async publishRawEnvelope(envelope: RawTelemetryEnvelope): Promise<void> {
    await this.producer.send({
      topic: KAFKA_TOPICS.TELEMETRY_RAW,
      messages: [
        {
          key: envelope.zoneId,
          value: JSON.stringify(envelope),
        },
      ],
    });
    this.metrics.rawKafkaProducedTotal.inc();
  }

  /**
   * Đẩy bản ghi sạch (hoặc bản ghi đánh dấu missing_signal) lên `telemetry.clean` và ghi vào TimescaleDB.
   */
  async emitCleanTelemetry(clean: CleanTelemetryMessage): Promise<void> {
    this.metrics.cleanedMessagesTotal.inc({
      zone_id: clean.zoneId,
      sensor_type: clean.type,
      quality: clean.quality,
    });

    this.readingsRepo.enqueue(clean);

    await this.producer.send({
      topic: KAFKA_TOPICS.TELEMETRY_CLEAN,
      messages: [
        {
          key: clean.zoneId,
          value: JSON.stringify(clean),
        },
      ],
    });
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.consumer.disconnect();
    await this.producer.disconnect();
  }

  private async ensureTopics(): Promise<void> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const existing = await admin.listTopics();
      const desired = [
        KAFKA_TOPICS.TELEMETRY_RAW,
        KAFKA_TOPICS.TELEMETRY_CLEAN,
        KAFKA_TOPICS.ALERTS,
      ];
      const missing = desired.filter((t) => !existing.includes(t));

      if (missing.length > 0) {
        await admin.createTopics({
          waitForLeaders: true,
          topics: missing.map((topic) => ({
            topic,
            numPartitions: this.options.topicPartitions,
            replicationFactor: 1,
          })),
        });
        this.logger.info('Created Kafka topics', {
          topics: missing,
          partitions: this.options.topicPartitions,
        });
      }
    } finally {
      await admin.disconnect();
    }
  }

  private async handleRawKafkaMessage(rawText: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      this.metrics.invalidMessagesTotal.inc({ reason: 'invalid_envelope_json' });
      return;
    }

    const envCheck = RawTelemetryEnvelopeSchema.safeParse(parsedJson);
    if (!envCheck.success) {
      this.metrics.invalidMessagesTotal.inc({ reason: 'invalid_envelope_schema' });
      return;
    }

    const envelope = envCheck.data;
    // Lưu trữ lạnh nguyên bản thô lên MinIO trước khi biến đổi
    this.archiveRepo.enqueue(envelope);

    const cleanResult = this.cleaner.processEnvelope(envelope);
    if (!cleanResult.ok) {
      this.metrics.invalidMessagesTotal.inc({ reason: cleanResult.reason });
      return;
    }

    await this.emitCleanTelemetry(cleanResult.data);
  }
}
