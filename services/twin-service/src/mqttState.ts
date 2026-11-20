import mqtt from "mqtt";
import { mqttTopics, parseMqttTopic, ValveStateMsg } from "@farm/shared";
import type { TwinService } from "./service";

/** Subscribe trạng thái van từ simulator/actuator và đưa vào twin. Payload hỏng bị bỏ qua. */
export function startMqttValveState(service: TwinService, url: string, username?: string, password?: string) {
  const c = mqtt.connect(url, { username, password, reconnectPeriod: 2000 });
  c.on("connect", () => c.subscribe(mqttTopics.allValveState(), { qos: 1 }));
  c.on("message", (topic, payload) => {
    const t = parseMqttTopic(topic);
    if (!t || t.kind !== "valveState") return;
    try {
      const body = JSON.parse(payload.toString());
      const msg = ValveStateMsg.safeParse({ ...body, zoneId: t.zoneId, ts: body.ts ?? new Date().toISOString() });
      if (msg.success) void service.ingestValveState(msg.data);
    } catch { /* bỏ qua */ }
  });
  return () => c.end();
}
