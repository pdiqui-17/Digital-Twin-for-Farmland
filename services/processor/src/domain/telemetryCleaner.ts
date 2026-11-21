import {
  CanonicalUnit,
  CleanTelemetryMessage,
  DataQuality,
  normalizeSensorUnit,
  RawTelemetryEnvelope,
  SENSOR_SPECS,
  SensorTelemetryMessageSchema,
  SensorType,
} from '@digital-twin/shared';

interface SensorTrackingState {
  farmId: string;
  zoneId: string;
  sensorId: string;
  type: SensorType;
  unit: CanonicalUnit;
  emaValue: number;
  lastNormalizedValue: number;
  identicalCount: number;
  lastSeenMs: number;
  markedMissing: boolean;
}

export type CleanResult =
  | { ok: true; data: CleanTelemetryMessage }
  | { ok: false; reason: 'invalid_json' | 'invalid_schema' | 'invalid_unit' };

export interface TelemetryCleanerOptions {
  /** Số lần liên tiếp giá trị đứng im không đổi để gắn cờ 'stuck' */
  stuckThresholdCount: number;
  /** Thời gian tối đa không nhận được tín hiệu trước khi gắn cờ 'missing_signal' (ms) */
  missingSignalTimeoutMs: number;
}

/**
 * Ngưỡng nhảy bậc đột biến tối đa giữa 2 chu kỳ đọc liên tiếp trước khi kích hoạt bộ làm mượt nhiễu EMA.
 */
const MAX_PLAUSIBLE_STEP_DELTA: Record<SensorType, number> = {
  soil_moisture: 8.5,
  air_temperature: 4.5,
  air_humidity: 14.0,
  light_intensity: 38000,
};

export class TelemetryCleaner {
  private readonly sensorStates = new Map<string, SensorTrackingState>();

  constructor(private readonly options: TelemetryCleanerOptions) {}

  getTrackedSensorCount(): number {
    return this.sensorStates.size;
  }

  /**
   * Kiểm định schema Zod, chuẩn hóa đơn vị, phát hiện lỗi (out_of_range, stuck) và lọc nhiễu mượt.
   */
  processEnvelope(envelope: RawTelemetryEnvelope, nowMs = Date.now()): CleanResult {
    let rawObj: unknown;
    try {
      rawObj = JSON.parse(envelope.rawPayload);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }

    const parsed = SensorTelemetryMessageSchema.safeParse(rawObj);
    if (!parsed.success) {
      return { ok: false, reason: 'invalid_schema' };
    }

    const msg = parsed.data;
    const farmId = msg.farmId ?? envelope.farmId;
    const zoneId = msg.zoneId || envelope.zoneId;
    const sensorId = msg.sensorId || envelope.sensorId;

    const normalized = normalizeSensorUnit(msg.type, msg.value, msg.unit);
    if (!normalized) {
      return { ok: false, reason: 'invalid_unit' };
    }

    const spec = SENSOR_SPECS[msg.type];
    const ingestedAt = new Date(nowMs).toISOString();
    const prevState = this.sensorStates.get(sensorId);

    // 1. Kiểm tra vượt ngưỡng vật lý hợp lệ (out_of_range)
    // Giữ nguyên giá trị lỗi trên trường value để dễ chẩn đoán nhưng KHÔNG cập nhật vào EMA lịch sử
    if (normalized.value < spec.minValid || normalized.value > spec.maxValid) {
      if (prevState) {
        prevState.lastSeenMs = nowMs;
        prevState.markedMissing = false;
      }
      return {
        ok: true,
        data: {
          farmId,
          zoneId,
          sensorId,
          type: msg.type,
          value: normalized.value,
          rawValue: msg.value !== normalized.value ? msg.value : undefined,
          unit: normalized.unit,
          ts: msg.ts,
          ingestedAt,
          quality: 'out_of_range',
        },
      };
    }

    // 2. Khởi tạo trạng thái theo dõi nếu là cảm biến mới gặp lần đầu
    if (!prevState) {
      this.sensorStates.set(sensorId, {
        farmId,
        zoneId,
        sensorId,
        type: msg.type,
        unit: normalized.unit,
        emaValue: normalized.value,
        lastNormalizedValue: normalized.value,
        identicalCount: 1,
        lastSeenMs: nowMs,
        markedMissing: false,
      });

      return {
        ok: true,
        data: {
          farmId,
          zoneId,
          sensorId,
          type: msg.type,
          value: normalized.value,
          rawValue: msg.value !== normalized.value ? msg.value : undefined,
          unit: normalized.unit,
          ts: msg.ts,
          ingestedAt,
          quality: 'ok',
        },
      };
    }

    // 3. Phát hiện cảm biến kẹt giá trị (stuck)
    // Lưu ý thực tế: Ban đêm ánh sáng = 0 lux liên tục là hiện tượng vật lý bình thường, không coi là kẹt!
    const isNightZeroLight = msg.type === 'light_intensity' && normalized.value === 0;
    if (!isNightZeroLight && Math.abs(normalized.value - prevState.lastNormalizedValue) < 1e-6) {
      prevState.identicalCount += 1;
    } else {
      prevState.identicalCount = 1;
    }

    prevState.lastNormalizedValue = normalized.value;
    prevState.lastSeenMs = nowMs;
    prevState.markedMissing = false;

    let finalValue = normalized.value;
    let quality: DataQuality = 'ok';

    if (prevState.identicalCount >= this.options.stuckThresholdCount) {
      quality = 'stuck';
    } else {
      // 4. Lọc nhiễu gai đột biến (Transient Spike Smoothing bằng EMA)
      const delta = Math.abs(normalized.value - prevState.emaValue);
      if (delta > MAX_PLAUSIBLE_STEP_DELTA[msg.type]) {
        finalValue = round2(0.35 * normalized.value + 0.65 * prevState.emaValue);
        prevState.emaValue = finalValue;
        quality = 'noisy_smoothed';
      } else {
        prevState.emaValue = round2(0.5 * normalized.value + 0.5 * prevState.emaValue);
      }
    }

    const rawChanged = Math.abs(msg.value - finalValue) > 1e-6;

    return {
      ok: true,
      data: {
        farmId,
        zoneId,
        sensorId,
        type: msg.type,
        value: finalValue,
        rawValue: rawChanged ? msg.value : undefined,
        unit: normalized.unit,
        ts: msg.ts,
        ingestedAt,
        quality,
      },
    };
  }

  /**
   * Quét định kỳ phát hiện các cảm biến bị đứt kết nối / mất tín hiệu quá ngưỡng thời gian chờ.
   * Mỗi đợt mất kết nối của 1 cảm biến phát ra 1 bản ghi cảnh báo `quality: 'missing_signal'`.
   */
  detectMissingSignals(nowMs = Date.now()): CleanTelemetryMessage[] {
    const alerts: CleanTelemetryMessage[] = [];
    const nowIso = new Date(nowMs).toISOString();

    for (const state of this.sensorStates.values()) {
      if (
        !state.markedMissing &&
        nowMs - state.lastSeenMs > this.options.missingSignalTimeoutMs
      ) {
        state.markedMissing = true;
        alerts.push({
          farmId: state.farmId,
          zoneId: state.zoneId,
          sensorId: state.sensorId,
          type: state.type,
          value: state.emaValue,
          unit: state.unit,
          ts: nowIso,
          ingestedAt: nowIso,
          quality: 'missing_signal',
        });
      }
    }

    return alerts;
  }
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}
