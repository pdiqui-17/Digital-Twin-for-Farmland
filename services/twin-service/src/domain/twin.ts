import {
  isUsableQuality,
  type CleanTelemetryMessage,
  type SensorSnapshot,
  type SensorType,
  type Thresholds,
  type TwinValveState,
  type ZoneState,
} from "@digital-twin/shared";
import { classifyStatus, fungalConditions, fungalRisk, nextFungalAccum, waterStress } from "./derived";

/** Phần của message telemetry.clean mà twin cần (farmId/ingestedAt không bắt buộc cho dev/test). */
export type TwinReading = Pick<CleanTelemetryMessage, "sensorId" | "zoneId" | "type" | "value" | "unit" | "ts" | "quality"> & {
  farmId?: string;
};

export type DropReason = "sensor_fault" | "duplicate" | "out_of_order" | "future_ts" | "unknown_zone";

export interface ApplyResult {
  state: ZoneState;
  applied: boolean;
  reason?: DropReason;
}

export interface ValveUpdate {
  state: TwinValveState;
  ts: string;
  lastCommandId?: string;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_DT_MIN = 30;
const iso = (ms: number) => new Date(ms).toISOString();

export function initZone(zoneId: string, farmId: string, now: Date, thresholds: Thresholds): ZoneState {
  return {
    zoneId,
    farmId,
    updatedAt: now.toISOString(),
    lastDataAt: null,
    sensors: {},
    metrics: { soilMoisture: null, airTemperature: null, airHumidity: null, lightIntensity: null },
    derived: { waterStress: null, fungalRisk: 0, fungalAccumMin: 0 },
    faultySensors: [],
    valve: { state: "unknown", ts: null },
    thresholds,
    status: "unknown",
  };
}

const isFresh = (s: SensorSnapshot, now: Date, th: Thresholds) => now.getTime() - Date.parse(s.ts) <= th.staleAfterSec * 1000;

/** Trung bình theo loại, chỉ lấy sensor có chất lượng dùng được và còn "tươi" tại thời điểm now. */
function aggregate(sensors: Record<string, SensorSnapshot>, now: Date, th: Thresholds, type: SensorType) {
  const vals = Object.values(sensors)
    .filter((s) => s.type === type && isUsableQuality(s.quality) && isFresh(s, now, th))
    .map((s) => s.value);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function recomputeMetrics(state: ZoneState, now: Date): ZoneState {
  const th = state.thresholds;
  const m = (t: SensorType) => aggregate(state.sensors, now, th, t);
  const metrics = {
    soilMoisture: m("soil_moisture"),
    airTemperature: m("air_temperature"),
    airHumidity: m("air_humidity"),
    lightIntensity: m("light_intensity"),
  };
  const faultySensors = Object.entries(state.sensors)
    .filter(([, s]) => !isUsableQuality(s.quality) && isFresh(s, now, th))
    .map(([id]) => id)
    .sort();
  return {
    ...state,
    metrics,
    faultySensors,
    derived: { ...state.derived, waterStress: waterStress(metrics.soilMoisture, th) },
    status: classifyStatus(metrics.soilMoisture, th),
    updatedAt: now.toISOString(),
  };
}

/** Hàm thuần: áp một reading vào trạng thái zone (idempotent, chịu out-of-order). */
/**
 * @param timeScale số phút "ruộng" trong 1 phút thật (simTimeScale). `ts` của bản tin là giờ thật,
 *   nên khoảng cách giữa hai bản tin được nhân lên trước khi cộng dồn nguy cơ nấm.
 */
export function applyReading(prev: ZoneState, r: TwinReading, now: Date, timeScale = 1): ApplyResult {
  const tsMs = Date.parse(r.ts);
  if (tsMs - now.getTime() > MAX_FUTURE_SKEW_MS) return { state: prev, applied: false, reason: "future_ts" };

  const existing = prev.sensors[r.sensorId];
  if (existing) {
    const exMs = Date.parse(existing.ts);
    if (tsMs === exMs) return { state: prev, applied: false, reason: "duplicate" };
    if (tsMs < exMs) return { state: prev, applied: false, reason: "out_of_order" };
  }

  const snapshot: SensorSnapshot = { type: r.type, value: r.value, unit: r.unit, ts: r.ts, quality: r.quality };
  let next: ZoneState = { ...prev, sensors: { ...prev.sensors, [r.sensorId]: snapshot } };

  if (!isUsableQuality(r.quality)) {
    // out_of_range / stuck / missing_signal: ghi nhận sensor lỗi nhưng không để nó ảnh hưởng chỉ số.
    return { state: recomputeMetrics(next, now), applied: false, reason: "sensor_fault" };
  }

  const prevLast = prev.lastDataAt ? Date.parse(prev.lastDataAt) : null;
  const newLast = prevLast === null ? tsMs : Math.max(prevLast, tsMs);
  next = recomputeMetrics({ ...next, lastDataAt: iso(newLast) }, now);

  if (prevLast !== null && tsMs > prevLast) {
    const dtMin = Math.min(MAX_DT_MIN, ((tsMs - prevLast) / 60_000) * timeScale);
    const fav = fungalConditions(next.metrics.airHumidity, next.metrics.airTemperature);
    const accum = nextFungalAccum(prev.derived.fungalAccumMin, dtMin, fav);
    next = { ...next, derived: { ...next.derived, fungalAccumMin: accum, fungalRisk: fungalRisk(accum) } };
  }
  return { state: next, applied: true };
}

/** Làm tươi theo thời gian: sensor quá hạn bị loại khỏi chỉ số, zone có thể thành unknown. */
export function refresh(prev: ZoneState, now: Date): ZoneState {
  return recomputeMetrics(prev, now);
}

/** Đổi ngưỡng (ví dụ danh mục zone thay đổi) và tính lại chỉ số. */
export function withThresholds(prev: ZoneState, th: Thresholds, now: Date): ZoneState {
  return recomputeMetrics({ ...prev, thresholds: th }, now);
}

export function applyValveState(prev: ZoneState, msg: ValveUpdate): ZoneState {
  if (prev.valve.ts && Date.parse(msg.ts) < Date.parse(prev.valve.ts)) return prev;
  return { ...prev, valve: { state: msg.state, ts: msg.ts, lastCommandId: msg.lastCommandId } };
}
