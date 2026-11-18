import {
  ValveCommandMessage,
  ValveStateMessage,
  ValveStateValue,
} from '@digital-twin/shared';
import { AmbientWeather } from './weatherProvider';

export type SoilType = 'sandy' | 'loam' | 'clay';

interface SoilPhysicsParams {
  /** Độ ẩm giữ nước tối đa tự nhiên (Field Capacity, %) */
  fieldCapacity: number;
  /** Độ ẩm tàn dư tối thiểu khi khô kiệt (Wilting/Residual floor, %) */
  residualFloor: number;
  /** Tốc độ thấm từ lớp mặt xuống tầng rễ (0..1 mỗi giờ mô phỏng) */
  infiltrationRatePerHour: number;
  /** Hệ số thoát hơi nước của đất */
  evaporationMultiplier: number;
  /** Tốc độ rút nước trọng lực khi vượt Field Capacity */
  drainageRatePerHour: number;
}

const SOIL_PARAMS: Record<SoilType, SoilPhysicsParams> = {
  sandy: {
    fieldCapacity: 74,
    residualFloor: 6,
    infiltrationRatePerHour: 0.85,
    evaporationMultiplier: 1.35,
    drainageRatePerHour: 0.45,
  },
  loam: {
    fieldCapacity: 82,
    residualFloor: 10,
    infiltrationRatePerHour: 0.6,
    evaporationMultiplier: 1.0,
    drainageRatePerHour: 0.25,
  },
  clay: {
    fieldCapacity: 88,
    residualFloor: 14,
    infiltrationRatePerHour: 0.38,
    evaporationMultiplier: 0.78,
    drainageRatePerHour: 0.12,
  },
};

export interface ZonePhysicalState {
  zoneId: string;
  zoneCode: string;
  name: string;
  cropType: string;
  cropCoefficientKc: number;
  soilType: SoilType;
  areaSqm: number;
  /** Độ ẩm tầng mặt (%) - nhận nước mưa & tưới trực tiếp */
  surfaceMoisture: number;
  /** Độ ẩm tầng rễ (%) - giá trị thực tế mà cảm biến đất đo được */
  rootSoilMoisture: number;
  airTemperature: number;
  airHumidity: number;
  lightIntensityLux: number;
  microclimateTempOffset: number;
  valve: {
    actuatorId: string;
    state: ValveStateValue;
    flowRateLpm: number;
    lastCommandId?: string;
    /** Thời điểm đồng hồ thực (ms) tự động đóng van nếu lệnh mở có durationSec */
    autoCloseAtMs?: number;
  };
}

interface ZonePreset {
  suffix: string;
  name: string;
  cropType: string;
  cropCoefficientKc: number;
  soilType: SoilType;
  areaSqm: number;
  initialMoisture: number;
  flowRateLpm: number;
  tempOffset: number;
}

const BASE_ZONE_PRESETS: ZonePreset[] = [
  {
    suffix: 'A',
    name: 'Khu A - Cà chua nhà màng',
    cropType: 'tomato',
    cropCoefficientKc: 1.05,
    soilType: 'loam',
    areaSqm: 10000,
    initialMoisture: 58.0,
    flowRateLpm: 25.0,
    tempOffset: 0.4,
  },
  {
    suffix: 'B',
    name: 'Khu B - Xà lách luống cát',
    cropType: 'lettuce',
    cropCoefficientKc: 1.15,
    soilType: 'sandy',
    areaSqm: 8000,
    initialMoisture: 64.0,
    flowRateLpm: 30.0,
    tempOffset: 0.8,
  },
  {
    suffix: 'C',
    name: 'Khu C - Ớt chuông ngọt',
    cropType: 'bell_pepper',
    cropCoefficientKc: 1.0,
    soilType: 'loam',
    areaSqm: 12000,
    initialMoisture: 53.0,
    flowRateLpm: 25.0,
    tempOffset: -0.2,
  },
  {
    suffix: 'D',
    name: 'Khu D - Dâu tây cao sản',
    cropType: 'strawberry',
    cropCoefficientKc: 0.9,
    soilType: 'clay',
    areaSqm: 10000,
    initialMoisture: 66.0,
    flowRateLpm: 20.0,
    tempOffset: -0.6,
  },
];

export class FarmEngine {
  private readonly zones = new Map<string, ZonePhysicalState>();
  private droughtMode: boolean;

  constructor(
    private readonly farmId: string,
    zoneCount: number,
    initialDroughtMode: boolean,
  ) {
    this.droughtMode = initialDroughtMode;
    this.initZones(zoneCount);
  }

  private initZones(zoneCount: number): void {
    for (let i = 0; i < zoneCount; i++) {
      const preset = BASE_ZONE_PRESETS[i % BASE_ZONE_PRESETS.length];
      const zoneCode = i < 26 ? String.fromCharCode(65 + i) : `Z${i + 1}`;
      const zoneId = `zone-${zoneCode}`;

      this.zones.set(zoneId, {
        zoneId,
        zoneCode,
        name: i < BASE_ZONE_PRESETS.length ? preset.name : `Khu ${zoneCode} - Mở rộng`,
        cropType: preset.cropType,
        cropCoefficientKc: preset.cropCoefficientKc,
        soilType: preset.soilType,
        areaSqm: preset.areaSqm,
        surfaceMoisture: preset.initialMoisture,
        rootSoilMoisture: preset.initialMoisture,
        airTemperature: 22.0 + preset.tempOffset,
        airHumidity: 70.0,
        lightIntensityLux: 25000,
        microclimateTempOffset: preset.tempOffset,
        valve: {
          actuatorId: `valve-${zoneId}`,
          state: 'closed',
          flowRateLpm: preset.flowRateLpm,
        },
      });
    }
  }

  isDroughtMode(): boolean {
    return this.droughtMode;
  }

  setDroughtMode(enabled: boolean): void {
    this.droughtMode = enabled;
  }

  getZones(): ZonePhysicalState[] {
    return Array.from(this.zones.values());
  }

  getZone(zoneId: string): ZonePhysicalState | undefined {
    return this.zones.get(zoneId);
  }

  getAllValveStateMessages(now = new Date()): ValveStateMessage[] {
    return this.getZones().map((z) => this.buildValveStateMessage(z, now));
  }

  /**
   * Áp dụng lệnh đóng/mở van tưới từ MQTT và trả về bản tin trạng thái mới.
   */
  applyValveCommand(cmd: ValveCommandMessage, nowMs = Date.now()): ValveStateMessage | null {
    const zone = this.zones.get(cmd.zoneId);
    if (!zone) {
      return null;
    }

    if (cmd.action === 'open') {
      zone.valve.state = 'open';
      zone.valve.lastCommandId = cmd.commandId;
      zone.valve.autoCloseAtMs = cmd.durationSec
        ? nowMs + cmd.durationSec * 1000
        : undefined;
    } else {
      zone.valve.state = 'closed';
      zone.valve.lastCommandId = cmd.commandId;
      zone.valve.autoCloseAtMs = undefined;
    }

    return this.buildValveStateMessage(zone, new Date(nowMs));
  }

  /**
   * Tiến mô hình vật lý thêm `physicsMinutes` phút thời gian mô phỏng.
   * Trả về danh sách các van tưới vừa tự động đóng khi hết `durationSec` để phát lên MQTT.
   */
  stepPhysics(
    ambient: AmbientWeather,
    physicsMinutes: number,
    nowMs = Date.now(),
  ): ValveStateMessage[] {
    const dtHours = physicsMinutes / 60;
    const autoClosedValves: ValveStateMessage[] = [];

    for (const zone of this.zones.values()) {
      // 1. Kiểm tra hẹn giờ tự đóng van tưới
      if (
        zone.valve.state === 'open' &&
        zone.valve.autoCloseAtMs !== undefined &&
        nowMs >= zone.valve.autoCloseAtMs
      ) {
        zone.valve.state = 'closed';
        zone.valve.autoCloseAtMs = undefined;
        autoClosedValves.push(this.buildValveStateMessage(zone, new Date(nowMs)));
      }

      const soil = SOIL_PARAMS[zone.soilType];
      const isIrrigating = zone.valve.state === 'open';

      // 2. Vi khí hậu từng zone (khi đang tưới thì mát hơn ~1.2°C và ẩm không khí tăng ~5%)
      const targetTemp =
        ambient.temperatureCelsius +
        zone.microclimateTempOffset -
        (isIrrigating ? 1.2 : 0);
      const targetAirHumidity = clamp(
        ambient.humidityPercent - zone.microclimateTempOffset * 1.5 + (isIrrigating ? 5.0 : 0),
        12,
        99,
      );

      // Quán tính nhiệt & ẩm không khí mượt giữa các nhịp
      zone.airTemperature = lerp(zone.airTemperature, targetTemp, 0.35);
      zone.airHumidity = lerp(zone.airHumidity, targetAirHumidity, 0.35);
      zone.lightIntensityLux = Math.max(
        0,
        ambient.lightLux * (zone.cropType === 'tomato' ? 0.88 : 1.0), // nhà màng che nắng nhẹ
      );

      // 3. Bốc thoát hơi nước phi tuyến (Penman-inspired VPD + bức xạ + hệ số cây trồng)
      const tempFactor = Math.max(0.15, (zone.airTemperature - 5) / 25);
      const drynessFactor = Math.pow((100 - zone.airHumidity) / 60, 1.15);
      const solarFactor = 0.25 + (zone.lightIntensityLux / 90000) * 1.35;
      const droughtStressBoost = this.droughtMode ? 3.2 : 1.0;

      // Khi đất khô sát ngưỡng residualFloor thì tốc độ bốc hơi tự giảm dần (phi tuyến thực tế)
      const availableWaterRatio = clamp(
        (zone.rootSoilMoisture - soil.residualFloor) / (soil.fieldCapacity - soil.residualFloor),
        0.05,
        1.25,
      );

      const evapPercentPerHour =
        1.35 *
        tempFactor *
        drynessFactor *
        solarFactor *
        zone.cropCoefficientKc *
        soil.evaporationMultiplier *
        droughtStressBoost *
        Math.sqrt(availableWaterRatio);

      // 4. Lượng nước bổ sung từ mưa và hệ thống van tưới nhỏ giọt/phun mưa
      const rainInputPerHour = ambient.precipitationMmPerHour * 2.1;
      // Tưới tập trung trực tiếp vào luống cây (hiệu suất tưới vùng rễ cao)
      const irrigationInputPerHour = isIrrigating
        ? (zone.valve.flowRateLpm / 25.0) * 16.5
        : 0;

      // 5. Cập nhật cân bằng nước 2 tầng (Tầng mặt <-> Tầng rễ + Thoát nước trọng lực)
      zone.surfaceMoisture = clamp(
        zone.surfaceMoisture +
          (rainInputPerHour + irrigationInputPerHour - evapPercentPerHour * 0.65) * dtHours,
        soil.residualFloor,
        99.0,
      );

      const infiltrationDelta =
        (zone.surfaceMoisture - zone.rootSoilMoisture) *
        Math.min(0.95, soil.infiltrationRatePerHour * (isIrrigating ? 2.4 : 1.0) * dtHours * 4);

      const rootDirectEvap = evapPercentPerHour * 0.55 * dtHours;

      // Nếu vượt Field Capacity, nước rút xuống tầng sâu theo trọng lực
      const excessAboveFieldCap = Math.max(0, zone.rootSoilMoisture - soil.fieldCapacity);
      const gravityDrainage = excessAboveFieldCap * soil.drainageRatePerHour * dtHours;

      zone.surfaceMoisture = clamp(zone.surfaceMoisture - infiltrationDelta * 0.5, soil.residualFloor, 99.0);
      zone.rootSoilMoisture = clamp(
        zone.rootSoilMoisture + infiltrationDelta - rootDirectEvap - gravityDrainage,
        soil.residualFloor,
        98.5,
      );
    }

    return autoClosedValves;
  }

  private buildValveStateMessage(zone: ZonePhysicalState, now: Date): ValveStateMessage {
    return {
      farmId: this.farmId,
      zoneId: zone.zoneId,
      actuatorId: zone.valve.actuatorId,
      state: zone.valve.state,
      lastCommandId: zone.valve.lastCommandId,
      flowRateLitersPerMin: zone.valve.state === 'open' ? zone.valve.flowRateLpm : 0,
      ts: now.toISOString(),
    };
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
