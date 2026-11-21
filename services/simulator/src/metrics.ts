import { createServiceRegistry, promClient } from '@digital-twin/shared';

export interface SimulatorMetrics {
  registry: ReturnType<typeof createServiceRegistry>;
  telemetryPublishedTotal: promClient.Counter<'zone_id' | 'sensor_type'>;
  telemetryDroppedTotal: promClient.Counter<'zone_id' | 'reason'>;
  valveCommandsReceivedTotal: promClient.Counter<'zone_id' | 'action' | 'status'>;
  activeSensorsGauge: promClient.Gauge;
  droughtModeGauge: promClient.Gauge;
  zoneSoilMoistureGauge: promClient.Gauge<'zone_id'>;
  tickDurationSeconds: promClient.Histogram;
}

export function createSimulatorMetrics(): SimulatorMetrics {
  const registry = createServiceRegistry('simulator');

  const telemetryPublishedTotal = new promClient.Counter({
    name: 'simulator_telemetry_published_total',
    help: 'Total sensor telemetry messages published to MQTT',
    labelNames: ['zone_id', 'sensor_type'] as const,
    registers: [registry],
  });

  const telemetryDroppedTotal = new promClient.Counter({
    name: 'simulator_telemetry_dropped_total',
    help: 'Total sensor telemetry readings skipped due to dropout fault or MQTT disconnect',
    labelNames: ['zone_id', 'reason'] as const,
    registers: [registry],
  });

  const valveCommandsReceivedTotal = new promClient.Counter({
    name: 'simulator_valve_commands_received_total',
    help: 'Total actuator valve commands received over MQTT',
    labelNames: ['zone_id', 'action', 'status'] as const,
    registers: [registry],
  });

  const activeSensorsGauge = new promClient.Gauge({
    name: 'simulator_active_sensors',
    help: 'Total number of simulated sensors across all zones',
    registers: [registry],
  });

  const droughtModeGauge = new promClient.Gauge({
    name: 'simulator_drought_mode',
    help: 'Whether drought scenario is currently active (1 = active, 0 = normal)',
    registers: [registry],
  });

  const zoneSoilMoistureGauge = new promClient.Gauge({
    name: 'simulator_zone_soil_moisture_percent',
    help: 'Ground-truth physical root-zone soil moisture percentage per zone',
    labelNames: ['zone_id'] as const,
    registers: [registry],
  });

  const tickDurationSeconds = new promClient.Histogram({
    name: 'simulator_tick_duration_seconds',
    help: 'Time spent computing physics and publishing MQTT messages per tick',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });

  return {
    registry,
    telemetryPublishedTotal,
    telemetryDroppedTotal,
    valveCommandsReceivedTotal,
    activeSensorsGauge,
    droughtModeGauge,
    zoneSoilMoistureGauge,
    tickDurationSeconds,
  };
}
