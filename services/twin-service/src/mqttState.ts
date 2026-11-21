import mqtt from "mqtt";
import { MQTT_TOPICS, parseValveTopic, ValveStateMessageSchema } from "@digital-twin/shared";
import type { TwinService } from "./service";

/** Subscribe trạng thái van (retained) từ simulator/actuator và đưa vào twin. Payload hỏng bị bỏ qua. */
export function startMqttValveState(
  service: TwinService,
  opts: { url: string; farmId?: string; username?: string; password?: string },
) {
  const c = mqtt.connect(opts.url, { username: opts.username || undefined, password: opts.password || undefined, reconnectPeriod: 2000 });
  c.on("connect", () => c.subscribe(MQTT_TOPICS.valveStateWildcard(opts.farmId), { qos: 1 }));
  c.on("message", (topic, payload) => {
    const t = parseValveTopic(topic);
    if (!t || t.channel !== "state") return;
    let body: unknown;
    try { body = JSON.parse(payload.toString()); } catch { return; }
    const msg = ValveStateMessageSchema.safeParse(body);
    if (!msg.success || msg.data.zoneId !== t.zoneId) return;
    service
      .ingestValveState(t.zoneId, { state: msg.data.state, ts: msg.data.ts, lastCommandId: msg.data.lastCommandId }, t.farmId)
      .catch((e) => console.error("valve state ingest failed:", (e as Error).message));
  });
  return () => c.end();
}
