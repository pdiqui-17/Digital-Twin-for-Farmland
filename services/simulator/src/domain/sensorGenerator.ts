import {
  SENSOR_SPECS,
  SensorTelemetryMessage,
  SensorType,
} from '@digital-twin/shared';
import { ZonePhysicalState } from './farmEngine';

export type SensorFaultMode = 'none' | 'dropout' | 'stuck' | 'out_of_range' | 'drift';

export interface SimulatedSensorMeta {
  sensorId: string;
  zoneId: string;
  type: SensorType;
  isVirtualReplica: boolean;
  /** Độ lệch hiệu chuẩn rất nhỏ cố định giữa các cảm biến cùng zone */
  calibrationBias: number;
  faultMode: SensorFaultMode;
  stuckValue?: number;
  accumulatedDrift: number;
}

export interface GeneratedTickBatch {
  publishedMessages: SensorTelemetryMessage[];
  droppedSensors: Array<{ sensorId: string; zoneId: string; reason: 'dropout_fault' }>;
}

const SENSOR_TYPES_ORDER: SensorType[] = [
  'soil_moisture',
  'air_temperature',
  'air_humidity',
  'light_intensity',
];

const BASE_SENSOR_SUFFIX: Record<SensorType, string> = {
  soil_moisture: 'moisture',
  air_temperature: 'temp',
  air_humidity: 'humidity',
  light_intensity: 'light',
};

const NOISE_STD_DEV: Record<SensorType, number> = {
  soil_moisture: 0.35,
  air_temperature: 0.15,
  air_humidity: 0.45,
  light_intensity: 120,
};

export class SensorGenerator {
  private readonly sensors = new Map<string, SimulatedSensorMeta>();

  constructor(
    private readonly farmId: string,
    zones: ZonePhysicalState[],
    virtualSensorsPerZone: number,
    private altUnitProbability: number,
    private randomFaultRate: number,
  ) {
    this.initSensors(zones, virtualSensorsPerZone);
  }

  private initSensors(zones: ZonePhysicalState[], virtualSensorsPerZone: number): void {
    for (const zone of zones) {
      // 4 cảm biến gốc khớp 100% với db/seed/001_seed_default_farm.sql (s-A-moisture, s-A-temp...)
      for (const type of SENSOR_TYPES_ORDER) {
        const sensorId = `s-${zone.zoneCode}-${BASE_SENSOR_SUFFIX[type]}`;
        this.sensors.set(sensorId, {
          sensorId,
          zoneId: zone.zoneId,
          type,
          isVirtualReplica: false,
          calibrationBias: 0,
          faultMode: 'none',
          accumulatedDrift: 0,
        });
      }

      // Nhân bản thêm N cảm biến ảo phục vụ mở rộng tải (500+ sensors)
      for (let v = 1; v <= virtualSensorsPerZone; v++) {
        const type = SENSOR_TYPES_ORDER[(v - 1) % SENSOR_TYPES_ORDER.length];
        const padded = String(v).padStart(3, '0');
        const sensorId = `s-${zone.zoneCode}-v${padded}`;
        const smallBias = ((v % 7) - 3) * 0.12;
        this.sensors.set(sensorId, {
          sensorId,
          zoneId: zone.zoneId,
          type,
          isVirtualReplica: true,
          calibrationBias: smallBias,
          faultMode: 'none',
          accumulatedDrift: 0,
        });
      }
    }
  }

  getTotalSensorCount(): number {
    return this.sensors.size;
  }

  getActiveFaults(): Array<{ sensorId: string; zoneId: string; faultMode: SensorFaultMode }> {
    return Array.from(this.sensors.values())
      .filter((s) => s.faultMode !== 'none')
      .map((s) => ({
        sensorId: s.sensorId,
        zoneId: s.zoneId,
        faultMode: s.faultMode,
      }));
  }

  setRandomFaultRate(rate: number): void {
    this.randomFaultRate = Math.min(0.5, Math.max(0, rate));
  }

  setSensorFault(sensorId: string, mode: SensorFaultMode): boolean {
    const sensor = this.sensors.get(sensorId);
    if (!sensor) return false;

    sensor.faultMode = mode;
    if (mode !== 'stuck') {
      sensor.stuckValue = undefined;
    }
    if (mode !== 'drift') {
      sensor.accumulatedDrift = 0;
    }
    return true;
  }

  clearAllFaults(): void {
    for (const sensor of this.sensors.values()) {
      sensor.faultMode = 'none';
      sensor.stuckValue = undefined;
      sensor.accumulatedDrift = 0;
    }
  }

  /**
   * Sinh toàn bộ gói tin cảm biến cho một nhịp mô phỏng.
   */
  generateReadings(zones: ZonePhysicalState[], now = new Date()): GeneratedTickBatch {
    const zoneMap = new Map(zones.map((z) => [z.zoneId, z]));
    const ts = now.toISOString();
    const publishedMessages: SensorTelemetryMessage[] = [];
    const droppedSensors: Array<{ sensorId: string; zoneId: string; reason: 'dropout_fault' }> = [];

    for (const sensor of this.sensors.values()) {
      const zone = zoneMap.get(sensor.zoneId);
      if (!zone) continue;

      // Xác định chế độ lỗi hiệu lực ở nhịp này (lỗi tiêm cố định hoặc nhiễu sự cố tức thời)
      let effectiveFault = sensor.faultMode;
      if (effectiveFault === 'none' && this.randomFaultRate > 0 && Math.random() < this.randomFaultRate) {
        effectiveFault = Math.random() < 0.5 ? 'out_of_range' : 'dropout';
      }

      if (effectiveFault === 'dropout') {
        droppedSensors.push({
          sensorId: sensor.sensorId,
          zoneId: sensor.zoneId,
          reason: 'dropout_fault',
        });
        continue;
      }

      const trueValue = this.readGroundTruth(zone, sensor.type) + sensor.calibrationBias;
      let measuredCelsiusOrCanonical: number;

      if (effectiveFault === 'stuck') {
        if (sensor.stuckValue === undefined) {
          sensor.stuckValue = round2(trueValue);
        }
        measuredCelsiusOrCanonical = sensor.stuckValue;
      } else if (effectiveFault === 'out_of_range') {
        measuredCelsiusOrCanonical = this.generateOutOfRangeSpike(sensor.type);
      } else if (effectiveFault === 'drift') {
        sensor.accumulatedDrift += this.getDriftStep(sensor.type);
        measuredCelsiusOrCanonical =
          this.clampNormalReading(sensor.type, trueValue + this.gaussianNoise(sensor.type)) +
          sensor.accumulatedDrift;
      } else {
        // Hoạt động bình thường: giá trị vật lý thực + nhiễu Gaussian
        const noisy = trueValue + this.gaussianNoise(sensor.type);
        measuredCelsiusOrCanonical = this.clampNormalReading(sensor.type, noisy);
      }

      const formatted = this.formatValueAndUnit(sensor.type, measuredCelsiusOrCanonical);

      publishedMessages.push({
        sensorId: sensor.sensorId,
        zoneId: sensor.zoneId,
        farmId: this.farmId,
        type: sensor.type,
        value: formatted.value,
        unit: formatted.unit,
        ts,
        quality: 'ok', // Cảm biến thô tự báo 'ok'; nhiệm vụ gắn cờ lỗi thực sự thuộc về Processor!
      });
    }

    return { publishedMessages, droppedSensors };
  }

  private readGroundTruth(zone: ZonePhysicalState, type: SensorType): number {
    switch (type) {
      case 'soil_moisture':
        return zone.rootSoilMoisture;
      case 'air_temperature':
        return zone.airTemperature;
      case 'air_humidity':
        return zone.airHumidity;
      case 'light_intensity':
        return zone.lightIntensityLux;
    }
  }

  private clampNormalReading(type: SensorType, value: number): number {
    const spec = SENSOR_SPECS[type];
    return Math.min(spec.maxValid, Math.max(spec.minValid, value));
  }

  private generateOutOfRangeSpike(type: SensorType): number {
    const highSpike = Math.random() >= 0.4;
    switch (type) {
      case 'soil_moisture':
        return highSpike ? 132.5 : -14.2;
      case 'air_temperature':
        return highSpike ? 88.4 : -28.0;
      case 'air_humidity':
        return highSpike ? 125.0 : -9.5;
      case 'light_intensity':
        return highSpike ? 215000 : -1500;
    }
  }

  private getDriftStep(type: SensorType): number {
    switch (type) {
      case 'soil_moisture':
        return 1.2;
      case 'air_temperature':
        return 0.8;
      case 'air_humidity':
        return 1.5;
      case 'light_intensity':
        return 1500;
    }
  }

  /**
   * Thỉnh thoảng phát đơn vị thay thế hợp lệ ('%', '°F', 'klux') để kiểm chứng tầng chuẩn hóa của Processor.
   */
  private formatValueAndUnit(type: SensorType, canonicalValue: number): { value: number; unit: string } {
    const useAltUnit = this.altUnitProbability > 0 && Math.random() < this.altUnitProbability;
    if (!useAltUnit) {
      return {
        value: round2(canonicalValue),
        unit: SENSOR_SPECS[type].canonicalUnit,
      };
    }

    switch (type) {
      case 'soil_moisture':
      case 'air_humidity':
        return { value: round2(canonicalValue), unit: '%' };
      case 'air_temperature':
        return { value: round2((canonicalValue * 9) / 5 + 32), unit: '°F' };
      case 'light_intensity':
        return { value: round2(canonicalValue / 1000), unit: 'klux' };
    }
  }

  private gaussianNoise(type: SensorType): number {
    // Biến đổi Box-Muller chuẩn sinh nhiễu phân phối chuẩn N(0, stdDev^2)
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

    if (type === 'light_intensity') {
      // Ban đêm (0 lux) nhiễu ánh sáng rất nhỏ
      return z * NOISE_STD_DEV.light_intensity;
    }
    return z * NOISE_STD_DEV[type];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
