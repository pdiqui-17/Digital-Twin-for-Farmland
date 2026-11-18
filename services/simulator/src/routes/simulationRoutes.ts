import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { FarmEngine } from '../domain/farmEngine';
import { SensorFaultMode, SensorGenerator } from '../domain/sensorGenerator';
import { SimulatorMqttBridge } from '../mqttBridge';
import { AmbientWeather } from '../domain/weatherProvider';

const ScenarioUpdateSchema = z.object({
  droughtMode: z.boolean().optional(),
  randomFaultRate: z.number().min(0).max(0.5).optional(),
});

const FaultInjectionSchema = z.object({
  sensorId: z.string().min(1).optional(),
  mode: z.enum(['none', 'dropout', 'stuck', 'out_of_range', 'drift']).optional(),
  clearAll: z.boolean().optional(),
});

const ManualValveSchema = z.object({
  zoneId: z.string().min(1),
  action: z.enum(['open', 'close']),
  durationSec: z.number().int().positive().optional(),
});

export interface SimulationRouterDeps {
  farmId: string;
  farmEngine: FarmEngine;
  sensorGenerator: SensorGenerator;
  mqttBridge: SimulatorMqttBridge;
  getLatestWeather: () => AmbientWeather | null;
}

/**
 * REST API phục vụ quan sát trạng thái "thế giới thực" và kích hoạt kịch bản trực tiếp khi Demo:
 * - GET  /simulation/state    : Xem thời tiết, độ ẩm thực từng zone, van tưới, lỗi đang tiêm
 * - POST /simulation/scenario : Bật/tắt kịch bản hạn hán hoặc đổi tỷ lệ lỗi ngẫu nhiên
 * - POST /simulation/faults   : Tiêm lỗi (stuck, out_of_range, dropout, drift) cho 1 cảm biến hoặc xóa toàn bộ lỗi
 * - POST /simulation/valve    : Đóng/mở nhanh van tưới khi test thủ công
 */
export function createSimulationRouter(deps: SimulationRouterDeps): Router {
  const { farmId, farmEngine, sensorGenerator, mqttBridge, getLatestWeather } = deps;
  const router = Router();

  router.get('/simulation/state', (_req: Request, res: Response) => {
    res.status(200).json({
      farmId,
      droughtMode: farmEngine.isDroughtMode(),
      mqttConnected: mqttBridge.isConnected(),
      totalSensors: sensorGenerator.getTotalSensorCount(),
      activeFaults: sensorGenerator.getActiveFaults(),
      weather: getLatestWeather(),
      zones: farmEngine.getZones().map((z) => ({
        zoneId: z.zoneId,
        name: z.name,
        cropType: z.cropType,
        soilType: z.soilType,
        rootSoilMoisture: Math.round(z.rootSoilMoisture * 100) / 100,
        surfaceMoisture: Math.round(z.surfaceMoisture * 100) / 100,
        airTemperature: Math.round(z.airTemperature * 100) / 100,
        airHumidity: Math.round(z.airHumidity * 100) / 100,
        lightIntensityLux: Math.round(z.lightIntensityLux),
        valve: z.valve,
      })),
    });
  });

  router.post('/simulation/scenario', (req: Request, res: Response) => {
    const parsed = ScenarioUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
      return;
    }

    if (parsed.data.droughtMode !== undefined) {
      farmEngine.setDroughtMode(parsed.data.droughtMode);
    }
    if (parsed.data.randomFaultRate !== undefined) {
      sensorGenerator.setRandomFaultRate(parsed.data.randomFaultRate);
    }

    res.status(200).json({
      droughtMode: farmEngine.isDroughtMode(),
      activeFaults: sensorGenerator.getActiveFaults(),
    });
  });

  router.post('/simulation/faults', (req: Request, res: Response) => {
    const parsed = FaultInjectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
      return;
    }

    if (parsed.data.clearAll) {
      sensorGenerator.clearAllFaults();
      res.status(200).json({ cleared: true, activeFaults: [] });
      return;
    }

    if (!parsed.data.sensorId || !parsed.data.mode) {
      res.status(400).json({ error: 'Provide either { clearAll: true } or { sensorId, mode }' });
      return;
    }

    const updated = sensorGenerator.setSensorFault(
      parsed.data.sensorId,
      parsed.data.mode as SensorFaultMode,
    );
    if (!updated) {
      res.status(404).json({ error: `Sensor "${parsed.data.sensorId}" not found` });
      return;
    }

    res.status(200).json({
      sensorId: parsed.data.sensorId,
      mode: parsed.data.mode,
      activeFaults: sensorGenerator.getActiveFaults(),
    });
  });

  router.post('/simulation/valve', async (req: Request, res: Response) => {
    const parsed = ManualValveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', issues: parsed.error.issues });
      return;
    }

    const newState = farmEngine.applyValveCommand({
      commandId: `manual-${Date.now()}`,
      farmId,
      zoneId: parsed.data.zoneId,
      action: parsed.data.action,
      durationSec: parsed.data.durationSec,
      issuedBy: 'manual-api',
      ts: new Date().toISOString(),
    });

    if (!newState) {
      res.status(404).json({ error: `Zone "${parsed.data.zoneId}" not found` });
      return;
    }

    await mqttBridge.publishValveStates([newState]);
    res.status(200).json(newState);
  });

  return router;
}
