import mqtt, { MqttClient } from 'mqtt';
import {
  Logger,
  MQTT_TOPICS,
  parseValveTopic,
  SensorTelemetryMessage,
  ValveCommandMessageSchema,
  ValveStateMessage,
} from '@digital-twin/shared';
import { FarmEngine } from './domain/farmEngine';
import { SimulatorMetrics } from './metrics';

export interface MqttBridgeOptions {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientIdPrefix: string;
  farmId: string;
}

export class SimulatorMqttBridge {
  private client: MqttClient | null = null;
  private connected = false;

  constructor(
    private readonly options: MqttBridgeOptions,
    private readonly farmEngine: FarmEngine,
    private readonly metrics: SimulatorMetrics,
    private readonly logger: Logger,
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const clientId = `${this.options.clientIdPrefix}-${Math.random().toString(16).slice(2, 8)}`;
    const cmdWildcard = MQTT_TOPICS.valveCommandWildcard(this.options.farmId);

    this.client = mqtt.connect(this.options.brokerUrl, {
      clientId,
      username: this.options.username,
      password: this.options.password,
      reconnectPeriod: 3000,
      connectTimeout: 8000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.logger.info('Connected to MQTT broker', {
        brokerUrl: this.options.brokerUrl,
        clientId,
      });

      this.client?.subscribe(cmdWildcard, { qos: 1 }, (err) => {
        if (err) {
          this.logger.error('Failed to subscribe to valve command topic', {
            topic: cmdWildcard,
            error: err.message,
          });
          return;
        }
        this.logger.info('Subscribed to valve command topic', { topic: cmdWildcard });
        // Đồng bộ trạng thái van ban đầu lên MQTT (retained)
        void this.publishValveStates(this.farmEngine.getAllValveStateMessages());
      });
    });

    this.client.on('reconnect', () => {
      this.logger.warn('Reconnecting to MQTT broker...');
    });

    this.client.on('offline', () => {
      this.connected = false;
      this.logger.warn('MQTT client went offline');
    });

    this.client.on('close', () => {
      this.connected = false;
    });

    this.client.on('error', (err) => {
      this.logger.error('MQTT client error', { error: err.message });
    });

    this.client.on('message', (topic, payloadBuf) => {
      this.handleIncomingMessage(topic, payloadBuf);
    });
  }

  /**
   * Phát lô dữ liệu cảm biến theo từng cụm (chunk) để chạy mượt với 500+ cảm biến ảo.
   */
  async publishTelemetryBatch(messages: SensorTelemetryMessage[]): Promise<void> {
    if (!this.client || !this.connected) {
      for (const msg of messages) {
        this.metrics.telemetryDroppedTotal.inc({
          zone_id: msg.zoneId,
          reason: 'mqtt_disconnected',
        });
      }
      return;
    }

    const chunkSize = 100;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map((msg) => {
          const farmId = msg.farmId ?? this.options.farmId;
          const topic = MQTT_TOPICS.sensorTelemetry(farmId, msg.zoneId, msg.sensorId);
          return this.publishJson(topic, msg, false).then(() => {
            this.metrics.telemetryPublishedTotal.inc({
              zone_id: msg.zoneId,
              sensor_type: msg.type,
            });
          });
        }),
      );
    }
  }

  async publishValveStates(states: ValveStateMessage[]): Promise<void> {
    if (!this.client || !this.connected || states.length === 0) return;

    await Promise.all(
      states.map((st) => {
        const topic = MQTT_TOPICS.valveState(st.farmId, st.zoneId);
        return this.publishJson(topic, st, true);
      }),
    );
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    this.connected = false;
    await new Promise<void>((resolve) => {
      c.end(false, {}, () => resolve());
    });
  }

  private handleIncomingMessage(topic: string, payloadBuf: Buffer): void {
    const parsedTopic = parseValveTopic(topic);
    if (!parsedTopic || parsedTopic.channel !== 'cmd') {
      return;
    }

    let rawObj: unknown;
    try {
      rawObj = JSON.parse(payloadBuf.toString('utf8'));
    } catch {
      this.metrics.valveCommandsReceivedTotal.inc({
        zone_id: parsedTopic.zoneId,
        action: 'unknown',
        status: 'invalid_json',
      });
      this.logger.warn('Rejected malformed JSON on valve command topic', { topic });
      return;
    }

    // Bổ sung farmId/zoneId từ topic nếu người gửi lược bỏ trong body
    const candidate =
      typeof rawObj === 'object' && rawObj !== null
        ? {
            farmId: parsedTopic.farmId,
            zoneId: parsedTopic.zoneId,
            ts: new Date().toISOString(),
            ...rawObj,
          }
        : rawObj;

    const validation = ValveCommandMessageSchema.safeParse(candidate);
    if (!validation.success) {
      this.metrics.valveCommandsReceivedTotal.inc({
        zone_id: parsedTopic.zoneId,
        action: 'unknown',
        status: 'invalid_schema',
      });
      this.logger.warn('Rejected invalid valve command schema', {
        topic,
        issues: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }

    const cmd = validation.data;
    const newState = this.farmEngine.applyValveCommand(cmd);
    if (!newState) {
      this.metrics.valveCommandsReceivedTotal.inc({
        zone_id: cmd.zoneId,
        action: cmd.action,
        status: 'unknown_zone',
      });
      this.logger.warn('Received valve command for non-existent zone', { zoneId: cmd.zoneId });
      return;
    }

    this.metrics.valveCommandsReceivedTotal.inc({
      zone_id: cmd.zoneId,
      action: cmd.action,
      status: 'applied',
    });

    this.logger.info('Applied virtual valve command', {
      zoneId: cmd.zoneId,
      action: cmd.action,
      durationSec: cmd.durationSec ?? null,
      commandId: cmd.commandId,
    });

    void this.publishValveStates([newState]);
  }

  private publishJson(topic: string, data: unknown, retain: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client) {
        resolve();
        return;
      }
      this.client.publish(
        topic,
        JSON.stringify(data),
        { qos: retain ? 1 : 0, retain },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }
}
