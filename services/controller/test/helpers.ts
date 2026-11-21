import { deriveThresholds, type ZoneState } from "@digital-twin/shared";
import { classifyStatus } from "../../twin-service/src/domain/derived";
import { initZone } from "../../twin-service/src/domain/twin";

export const T0 = Date.parse("2026-01-01T08:00:00Z");
export const at = (min: number) => new Date(T0 + min * 60_000);

/** Ngưỡng của zone trong test: tối ưu 45-70% -> mở van < 45%, đóng ở 57.5%, critical < 35%. */
export const TH = deriveThresholds(45, 70);

/** Dựng ZoneState nhanh cho test bằng cách ghi đè metrics. */
export function zone(over: {
  moisture?: number | null; valve?: "open" | "closed" | "unknown"; valveTs?: Date; lastCommandId?: string;
  fungal?: number; faulty?: string[];
} = {}): ZoneState {
  const base = initZone("zone-A", "farm-01", at(0), TH);
  const m = over.moisture === undefined ? 50 : over.moisture;
  return {
    ...base,
    lastDataAt: m === null ? null : at(0).toISOString(),
    metrics: { ...base.metrics, soilMoisture: m },
    derived: { waterStress: null, fungalRisk: over.fungal ?? 0, fungalAccumMin: 0 },
    faultySensors: over.faulty ?? [],
    valve: { state: over.valve ?? "closed", ts: over.valveTs ? over.valveTs.toISOString() : null, lastCommandId: over.lastCommandId },
    status: classifyStatus(m, TH),
  };
}
