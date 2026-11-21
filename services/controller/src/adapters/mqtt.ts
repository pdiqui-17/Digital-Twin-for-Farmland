import mqtt from "mqtt";
import { MQTT_TOPICS, type ValveCommandMessage } from "@digital-twin/shared";
import type { CommandPublisher } from "./ports";

/** Gửi lệnh van qua MQTT (QoS 1, không retain) theo hợp đồng của Role A. */
export class MqttCommandPublisher implements CommandPublisher {
  private client: mqtt.MqttClient;
  constructor(url: string, username?: string, password?: string) {
    this.client = mqtt.connect(url, { username: username || undefined, password: password || undefined, reconnectPeriod: 2000 });
  }
  publish(cmd: ValveCommandMessage): Promise<void> {
    const topic = MQTT_TOPICS.valveCommand(cmd.farmId, cmd.zoneId);
    return new Promise((resolve, reject) =>
      this.client.publish(topic, JSON.stringify(cmd), { qos: 1, retain: false }, (err) => (err ? reject(err) : resolve())),
    );
  }
  close() { this.client.end(); }
}

/** Dùng khi chưa có broker: chỉ ghi log. */
export class LogCommandPublisher implements CommandPublisher {
  async publish(cmd: ValveCommandMessage) { console.log("[CMD]", JSON.stringify(cmd)); }
}
