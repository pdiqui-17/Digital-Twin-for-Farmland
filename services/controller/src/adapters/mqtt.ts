import mqtt from "mqtt";
import { mqttTopics, type Command } from "@farm/shared";
import type { CommandPublisher } from "./ports";

/** Gửi lệnh van qua MQTT (QoS 1). farmId lấy từ lệnh, nếu thiếu dùng mặc định. */
export class MqttCommandPublisher implements CommandPublisher {
  private client: mqtt.MqttClient;
  constructor(url: string, private defaultFarmId: string, username?: string, password?: string) {
    this.client = mqtt.connect(url, { username, password, reconnectPeriod: 2000 });
  }
  publish(cmd: Command): Promise<void> {
    const topic = mqttTopics.valveCmd(cmd.farmId ?? this.defaultFarmId, cmd.zoneId);
    return new Promise((resolve, reject) =>
      this.client.publish(topic, JSON.stringify(cmd), { qos: 1 }, (err) => (err ? reject(err) : resolve())),
    );
  }
  close() { this.client.end(); }
}

/** Dùng khi chưa có broker: chỉ ghi log. */
export class LogCommandPublisher implements CommandPublisher {
  async publish(cmd: Command) { console.log("[CMD]", JSON.stringify(cmd)); }
}
