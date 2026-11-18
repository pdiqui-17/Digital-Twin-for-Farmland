/**
 * Hợp đồng tên topic MQTT & Kafka dùng chung toàn hệ thống.
 * Thay đổi tại file này bắt buộc phải được cả 3 thành viên (Role A, B, C) duyệt.
 */

export const KAFKA_TOPICS = {
  /** Message cảm biến thô từ MQTT (Producer: Processor Bridge -> Consumer: Processor) */
  TELEMETRY_RAW: 'telemetry.raw',
  /** Dữ liệu đã làm sạch & gắn cờ chất lượng (Producer: Processor -> Consumer: Twin Service, Analytics) */
  TELEMETRY_CLEAN: 'telemetry.clean',
  /** Sự kiện cảnh báo (Producer: Twin Service, Controller -> Consumer: Controller) */
  ALERTS: 'alerts',
} as const;

export type KafkaTopicName = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export const MQTT_TOPICS = {
  /** Topic publish dữ liệu cảm biến: farm/{farmId}/zone/{zoneId}/sensor/{sensorId}/telemetry */
  sensorTelemetry: (farmId: string, zoneId: string, sensorId: string): string =>
    `farm/${farmId}/zone/${zoneId}/sensor/${sensorId}/telemetry`,

  /** Wildcard subscribe dữ liệu cảm biến cho một hoặc toàn bộ nông trại */
  sensorTelemetryWildcard: (farmId = '+'): string =>
    `farm/${farmId}/zone/+/sensor/+/telemetry`,

  /** Topic phản hồi trạng thái van tưới: farm/{farmId}/zone/{zoneId}/actuator/valve/state */
  valveState: (farmId: string, zoneId: string): string =>
    `farm/${farmId}/zone/${zoneId}/actuator/valve/state`,

  /** Wildcard subscribe trạng thái van tưới */
  valveStateWildcard: (farmId = '+'): string =>
    `farm/${farmId}/zone/+/actuator/valve/state`,

  /** Topic gửi lệnh điều khiển van tưới: farm/{farmId}/zone/{zoneId}/actuator/valve/cmd */
  valveCommand: (farmId: string, zoneId: string): string =>
    `farm/${farmId}/zone/${zoneId}/actuator/valve/cmd`,

  /** Wildcard subscribe lệnh điều khiển van tưới */
  valveCommandWildcard: (farmId = '+'): string =>
    `farm/${farmId}/zone/+/actuator/valve/cmd`,
} as const;

export interface ParsedSensorTopic {
  farmId: string;
  zoneId: string;
  sensorId: string;
}

export interface ParsedValveTopic {
  farmId: string;
  zoneId: string;
  channel: 'state' | 'cmd';
}

const SENSOR_TOPIC_REGEX = /^farm\/([^/+]+)\/zone\/([^/+]+)\/sensor\/([^/+]+)\/telemetry$/;
const VALVE_TOPIC_REGEX = /^farm\/([^/+]+)\/zone\/([^/+]+)\/actuator\/valve\/(state|cmd)$/;

/**
 * Tách farmId, zoneId, sensorId từ MQTT topic cảm biến.
 * Trả về null nếu topic không khớp định dạng chuẩn.
 */
export function parseSensorTelemetryTopic(topic: string): ParsedSensorTopic | null {
  const match = SENSOR_TOPIC_REGEX.exec(topic);
  if (!match) return null;
  return {
    farmId: match[1],
    zoneId: match[2],
    sensorId: match[3],
  };
}

/**
 * Tách farmId, zoneId, channel ('state' | 'cmd') từ MQTT topic van tưới.
 * Trả về null nếu topic không khớp định dạng chuẩn.
 */
export function parseValveTopic(topic: string): ParsedValveTopic | null {
  const match = VALVE_TOPIC_REGEX.exec(topic);
  if (!match) return null;
  return {
    farmId: match[1],
    zoneId: match[2],
    channel: match[3] as 'state' | 'cmd',
  };
}
