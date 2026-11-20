import {
  DEFAULT_THRESHOLDS,
  type Reading,
  type SensorSnapshot,
  type SensorType,
  type Thresholds,
  type ValveStateMsg,
  type ZoneState,
} from "@farm/shared";
import { classifyStatus, fungalConditions, fungalRisk, nextFungalAccum, waterStress } from "./derived";

export type DropReason = "bad_quality" | "duplicate" | "out_of_order" | "future_ts";

export interface ApplyResult {
  state: ZoneState;
  applied: boolean;
  reason?: DropReason;
}

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_DT_MIN = 30;
const iso = (ms: number) => new Date(ms).toISOString();

export function initZone(zoneId: string, farmId: string, now: Date): ZoneState {
  return {
    zoneId,
    farmId,
    updatedAt: now.toISOString(),
    lastDataAt: null,
    sensors: {},
    metrics: { soilMoisture: null, soilTemp: null, airTemp: null, airHumidity: null, rain: null },
    derived: { waterStress: null, fungalRisk: 0, fungalAccumMin: 0 },
    valve: { state: "unknown", ts: null },
    status: "unknown",
  };
}

/** Trung bình theo loại, chỉ lấy sensor không bad và còn "tươi" tại thời điểm now. */
function aggregate(sensors: Record<string, SensorSnapshot>, now: Date, th: Thresholds, type: SensorType) {
  const limit = th.staleAfterSec * 1000;
  const vals = Object.values(sensors)
    .filter((s) => s.type === type && s.quality !== "bad" && now.getTime() - Date.parse(s.ts) <= limit)
    .map((s) => s.value);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function recomputeMetrics(state: ZoneState, now: Date, th: Thresholds): ZoneState {
  const m = (t: SensorType) => aggregate(state.sensors, now, th, t);
  const metrics = {
    soilMoisture: m("soil_moisture"),
    soilTemp: m("soil_temp"),
    airTemp: m("air_temp"),
    airHumidity: m("air_humidity"),
    rain: m("rain"),
  };
  return {
    ...state,
    metrics,
    derived: { ...state.derived, waterStress: waterStress(metrics.soilMoisture, th) },
    status: classifyStatus(metrics.soilMoisture, th),
    updatedAt: now.toISOString(),
  };
}

/** Hàm thuần: áp một reading vào trạng thái zone (idempotent, chịu out-of-order). */
export function applyReading(
  prev: ZoneState,
  r: Reading,
  now: Date,
  th: Thresholds = DEFAULT_THRESHOLDS,
): ApplyResult {
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

  if (r.quality === "bad") {
    // Ghi nhận sensor lỗi trong twin nhưng không để nó ảnh hưởng chỉ số.
    return { state: recomputeMetrics(next, now, th), applied: false, reason: "bad_quality" };
  }

  const prevLast = prev.lastDataAt ? Date.parse(prev.lastDataAt) : null;
  const newLast = prevLast === null ? tsMs : Math.max(prevLast, tsMs);
  next = { ...next, lastDataAt: iso(newLast) };
  next = recomputeMetrics(next, now, th);

  if (prevLast !== null && tsMs > prevLast) {
    const dtMin = Math.min(MAX_DT_MIN, (tsMs - prevLast) / 60_000);
    const fav = fungalConditions(next.metrics.airHumidity, next.metrics.airTemp);
    const accum = nextFungalAccum(prev.derived.fungalAccumMin, dtMin, fav);
    next = { ...next, derived: { ...next.derived, fungalAccumMin: accum, fungalRisk: fungalRisk(accum) } };
  }
  return { state: next, applied: true };
}

/** Làm tươi theo thời gian: sensor quá hạn bị loại khỏi chỉ số, zone có thể thành unknown. */
export function refresh(prev: ZoneState, now: Date, th: Thresholds = DEFAULT_THRESHOLDS): ZoneState {
  return recomputeMetrics(prev, now, th);
}

export function applyValveState(prev: ZoneState, msg: ValveStateMsg): ZoneState {
  if (prev.valve.ts && Date.parse(msg.ts) < Date.parse(prev.valve.ts)) return prev;
  return { ...prev, valve: { state: msg.state, ts: msg.ts } };
}
