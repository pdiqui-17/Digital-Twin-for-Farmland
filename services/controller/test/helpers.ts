import { DEFAULT_THRESHOLDS, type ZoneState } from "@farm/shared";
import { initZone, refresh } from "../../twin-service/src/domain/twin";

export const T0 = Date.parse("2026-01-01T08:00:00Z");
export const at = (min: number) => new Date(T0 + min * 60_000);

/** Dựng ZoneState nhanh cho test bằng cách ghi đè metrics. */
export function zone(over: { moisture?: number | null; rain?: number; valve?: "open" | "closed" | "unknown"; valveTs?: Date; fungal?: number } = {}): ZoneState {
  const base = refresh(initZone("zone-A", "f1", at(0)), at(0), DEFAULT_THRESHOLDS);
  const m = over.moisture === undefined ? 30 : over.moisture;
  const status = m === null ? "unknown" : m < 22 ? "critical" : m < 28 ? "dry" : "ok";
  return {
    ...base,
    lastDataAt: m === null ? null : at(0).toISOString(),
    metrics: { ...base.metrics, soilMoisture: m, rain: over.rain ?? null },
    derived: { waterStress: null, fungalRisk: over.fungal ?? 0, fungalAccumMin: 0 },
    valve: { state: over.valve ?? "closed", ts: over.valveTs ? over.valveTs.toISOString() : null },
    status,
  };
}
