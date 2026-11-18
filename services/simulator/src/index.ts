import express from 'express';
import { createLogger, createObservabilityRouter } from '@digital-twin/shared';
import { loadSimulatorConfig } from './config';
import { FarmEngine } from './domain/farmEngine';
import { SensorGenerator } from './domain/sensorGenerator';
import { AmbientWeather, WeatherProvider } from './domain/weatherProvider';
import { createSimulatorMetrics } from './metrics';
import { SimulatorMqttBridge } from './mqttBridge';
import { createSimulationRouter } from './routes/simulationRoutes';

async function bootstrap(): Promise<void> {
  const config = loadSimulatorConfig();
  const logger = createLogger('simulator');
  const metrics = createSimulatorMetrics();

  const weatherProvider = new WeatherProvider(
    config.latitude,
    config.longitude,
    config.weatherEnabled,
    logger,
  );
  await weatherProvider.initialize();

  const farmEngine = new FarmEngine(config.farmId, config.zoneCount, config.droughtMode);
  const sensorGenerator = new SensorGenerator(
    config.farmId,
    farmEngine.getZones(),
    config.virtualSensorsPerZone,
    config.altUnitProbability,
    config.randomFaultRate,
  );

  metrics.activeSensorsGauge.set(sensorGenerator.getTotalSensorCount());
  metrics.droughtModeGauge.set(farmEngine.isDroughtMode() ? 1 : 0);

  const mqttBridge = new SimulatorMqttBridge(
    {
      brokerUrl: config.mqttBrokerUrl,
      username: config.mqttUsername,
      password: config.mqttPassword,
      clientIdPrefix: config.mqttClientIdPrefix,
      farmId: config.farmId,
    },
    farmEngine,
    metrics,
    logger,
  );
  await mqttBridge.connect();

  let latestWeather: AmbientWeather | null = null;
  let virtualWeatherClockMs = Date.now();
  let tickRunning = false;

  async function runSimulationTick(): Promise<void> {
    if (tickRunning) return;
    tickRunning = true;
    const stopTimer = metrics.tickDurationSeconds.startTimer();

    try {
      const realNow = new Date();
      // Đồng hồ thời tiết tiến theo physicsMinutesPerTick để thấy rõ biến thiên ngày/đêm,
      // trong khi timestamp bản tin `ts` luôn dùng giờ thực `realNow` để khớp Grafana & đo latency!
      virtualWeatherClockMs += config.physicsMinutesPerTick * 60_000;
      const weather = weatherProvider.getWeatherAt(
        new Date(virtualWeatherClockMs),
        farmEngine.isDroughtMode(),
      );
      latestWeather = weather;

      const autoClosedValves = farmEngine.stepPhysics(
        weather,
        config.physicsMinutesPerTick,
        realNow.getTime(),
      );
      if (autoClosedValves.length > 0) {
        await mqttBridge.publishValveStates(autoClosedValves);
        for (const v of autoClosedValves) {
          logger.info('Virtual valve auto-closed after duration elapsed', {
            zoneId: v.zoneId,
            actuatorId: v.actuatorId,
          });
        }
      }

      const zones = farmEngine.getZones();
      metrics.droughtModeGauge.set(farmEngine.isDroughtMode() ? 1 : 0);
      for (const z of zones) {
        metrics.zoneSoilMoistureGauge.set({ zone_id: z.zoneId }, z.rootSoilMoisture);
      }

      const batch = sensorGenerator.generateReadings(zones, realNow);
      for (const dropped of batch.droppedSensors) {
        metrics.telemetryDroppedTotal.inc({
          zone_id: dropped.zoneId,
          reason: dropped.reason,
        });
      }

      await mqttBridge.publishTelemetryBatch(batch.publishedMessages);
    } catch (err) {
      logger.error('Error during simulation tick', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      stopTimer();
      tickRunning = false;
    }
  }

  const app = express();
  app.use(express.json());
  app.use(
    createObservabilityRouter({
      serviceName: 'simulator',
      registry: metrics.registry,
      checkReady: () => ({
        ready: mqttBridge.isConnected(),
        details: {
          mqttConnected: mqttBridge.isConnected(),
        },
      }),
    }),
  );
  app.use(
    createSimulationRouter({
      farmId: config.farmId,
      farmEngine,
      sensorGenerator,
      mqttBridge,
      getLatestWeather: () => latestWeather,
    }),
  );

  const server = app.listen(config.port, () => {
    logger.info('Simulator service started', {
      port: config.port,
      farmId: config.farmId,
      zones: config.zoneCount,
      totalSensors: sensorGenerator.getTotalSensorCount(),
      tickIntervalMs: config.tickIntervalMs,
      droughtMode: config.droughtMode,
    });
  });

  // Thực thi nhịp đầu tiên ngay và đặt lịch định kỳ
  void runSimulationTick();
  const intervalHandle = setInterval(() => {
    void runSimulationTick();
  }, config.tickIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down simulator gracefully...`);
    clearInterval(intervalHandle);
    server.close();
    await mqttBridge.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  process.stderr.write(`Fatal simulator startup error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
