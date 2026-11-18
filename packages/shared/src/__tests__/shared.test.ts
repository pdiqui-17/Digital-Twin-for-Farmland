import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KAFKA_TOPICS,
  MQTT_TOPICS,
  parseSensorTelemetryTopic,
  parseValveTopic,
  SensorTelemetryMessageSchema,
  ValveCommandMessageSchema,
  normalizeSensorUnit,
} from '../index';

test('MQTT topic builders and parsers match project_assigning.md section 3.1', () => {
  const telemetryTopic = MQTT_TOPICS.sensorTelemetry('farm-01', 'zone-A', 's-A1');
  assert.equal(telemetryTopic, 'farm/farm-01/zone/zone-A/sensor/s-A1/telemetry');

  const parsedSensor = parseSensorTelemetryTopic(telemetryTopic);
  assert.deepEqual(parsedSensor, {
    farmId: 'farm-01',
    zoneId: 'zone-A',
    sensorId: 's-A1',
  });
  assert.equal(parseSensorTelemetryTopic('invalid/topic'), null);

  const valveCmdTopic = MQTT_TOPICS.valveCommand('farm-01', 'zone-B');
  assert.equal(valveCmdTopic, 'farm/farm-01/zone/zone-B/actuator/valve/cmd');
  assert.deepEqual(parseValveTopic(valveCmdTopic), {
    farmId: 'farm-01',
    zoneId: 'zone-B',
    channel: 'cmd',
  });

  const valveStateTopic = MQTT_TOPICS.valveState('farm-01', 'zone-B');
  assert.equal(valveStateTopic, 'farm/farm-01/zone/zone-B/actuator/valve/state');
  assert.deepEqual(parseValveTopic(valveStateTopic), {
    farmId: 'farm-01',
    zoneId: 'zone-B',
    channel: 'state',
  });
});

test('Kafka topic names match project_assigning.md section 3.2', () => {
  assert.equal(KAFKA_TOPICS.TELEMETRY_RAW, 'telemetry.raw');
  assert.equal(KAFKA_TOPICS.TELEMETRY_CLEAN, 'telemetry.clean');
  assert.equal(KAFKA_TOPICS.ALERTS, 'alerts');
});

test('SensorTelemetryMessageSchema validates section 3.4 sample payload', () => {
  const samplePayload = {
    sensorId: 's-A1',
    zoneId: 'zone-A',
    type: 'soil_moisture',
    value: 38.5,
    unit: 'percent',
    ts: '2026-01-01T08:00:00Z',
    quality: 'ok',
  };

  const parsed = SensorTelemetryMessageSchema.safeParse(samplePayload);
  assert.equal(parsed.success, true);
});

test('ValveCommandMessageSchema validates open/close actuator commands', () => {
  const cmd = {
    commandId: 'cmd-101',
    farmId: 'farm-01',
    zoneId: 'zone-A',
    action: 'open',
    durationSec: 120,
    reason: 'moisture_below_threshold',
    ts: '2026-01-01T08:05:00Z',
  };
  const parsed = ValveCommandMessageSchema.safeParse(cmd);
  assert.equal(parsed.success, true);
});

test('normalizeSensorUnit converts raw units to canonical units accurately', () => {
  assert.deepEqual(normalizeSensorUnit('soil_moisture', 0.425, 'ratio'), {
    value: 42.5,
    unit: 'percent',
  });
  assert.deepEqual(normalizeSensorUnit('air_temperature', 86, '°F'), {
    value: 30,
    unit: 'celsius',
  });
  assert.deepEqual(normalizeSensorUnit('light_intensity', 12.5, 'klux'), {
    value: 12500,
    unit: 'lux',
  });
  assert.equal(normalizeSensorUnit('soil_moisture', 25, 'celsius'), null);
});
