import mqtt, { MqttClient } from 'mqtt';
import {
  Logger,
  MQTT_TOPICS,
  parseSensorTelemetryTopic,
  RawTelemetryEnvelope,
} from '@digital-twin/shared';
import { ProcessorMetrics } from './metrics';

export interface MqttIngestorOptions {
  brokerUrl: string;
  username?: string;
  password?: string;
  sharedGroup: string;
}

export class MqttIngestor {
  private client: MqttClient | null = null;
  private connected = false;

  constructor(
    private readonly options: MqttIngestorOptions,
    private readonly onEnvelope: (envelope: RawTelemetryEnvelope) => Promise<void>,
    private readonly metrics: ProcessorMetrics,
    private readonly logger: Logger,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    const clientId = `dtf-processor-${Math.random().toString(16).slice(2, 8)}`;
    const sharedTopic = `$share/${this.options.sharedGroup}/${MQTT_TOPICS.sensorTelemetryWildcard('+')}`;

    this.client = mqtt.connect(this.options.brokerUrl, {
      clientId,
      username: this.options.username,
      password: this.options.password,
      protocolVersion: 5,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.logger.info('Processor connected to MQTT broker', {
        brokerUrl: this.options.brokerUrl,
        clientId,
      });

      this.client?.subscribe(sharedTopic, { qos: 0 }, (err) => {
        if (err) {
          this.logger.error('Failed to subscribe to shared telemetry MQTT topic', {
            topic: sharedTopic,
            error: err.message,
          });
          return;
        }
        this.logger.info('Subscribed to MQTT shared telemetry stream', { topic: sharedTopic });
      });
    });

    this.client.on('offline', () => {
      this.connected = false;
      this.logger.warn('Processor MQTT client offline');
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    this.client.on('error', (err) => {
      this.logger.error('Processor MQTT client error', { error: err.message });
    });

    this.client.on('message', (topic, payloadBuf) => {
      const parsed = parseSensorTelemetryTopic(topic);
      if (!parsed) return;

      this.metrics.mqttMessagesReceivedTotal.inc({ farm_id: parsed.farmId });

      const envelope: RawTelemetryEnvelope = {
        mqttTopic: topic,
        farmId: parsed.farmId,
        zoneId: parsed.zoneId,
        sensorId: parsed.sensorId,
        receivedAt: new Date().toISOString(),
        rawPayload: payloadBuf.toString('utf8'),
      };

      void this.onEnvelope(envelope).catch((err) => {
        this.logger.error('Failed to forward MQTT message to Kafka telemetry.raw', {
          sensorId: parsed.sensorId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    this.connected = false;
    await new Promise<void>((resolve) => {
      c.end(false, {}, () => resolve());
    });
  }
}
