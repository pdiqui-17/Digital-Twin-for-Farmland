export const KAFKA_TOPICS = {
  raw: "telemetry.raw",
  clean: "telemetry.clean",
  alerts: "alerts",
} as const;

export const mqttTopics = {
  telemetry: (farmId: string, zoneId: string, sensorId: string) =>
    `farm/${farmId}/zone/${zoneId}/sensor/${sensorId}/telemetry`,
  valveState: (farmId: string, zoneId: string) =>
    `farm/${farmId}/zone/${zoneId}/actuator/valve/state`,
  valveCmd: (farmId: string, zoneId: string) =>
    `farm/${farmId}/zone/${zoneId}/actuator/valve/cmd`,
  /** Wildcard dùng để subscribe. */
  allValveState: () => `farm/+/zone/+/actuator/valve/state`,
};

export interface ParsedTopic {
  farmId: string;
  zoneId: string;
  kind: "telemetry" | "valveState" | "valveCmd";
  sensorId?: string;
}

/** Tách farmId/zoneId/loại message từ tên topic MQTT; null nếu không khớp. */
export function parseMqttTopic(topic: string): ParsedTopic | null {
  const p = topic.split("/");
  if (p[0] !== "farm" || p[2] !== "zone" || !p[1] || !p[3]) return null;
  const base = { farmId: p[1], zoneId: p[3] };
  if (p.length === 7 && p[4] === "sensor" && p[6] === "telemetry" && p[5])
    return { ...base, kind: "telemetry", sensorId: p[5] };
  if (p.length === 7 && p[4] === "actuator" && p[5] === "valve") {
    if (p[6] === "state") return { ...base, kind: "valveState" };
    if (p[6] === "cmd") return { ...base, kind: "valveCmd" };
  }
  return null;
}
