import { clamp, type Thresholds } from "@digital-twin/shared";
import { forecast, type ForecastPoint, type IrrigationWindow } from "./forecast";
import type { HourlyWeather } from "./weather";
import type { Params } from "./waterBalance";

export interface Schedule { name: string; windows: IrrigationWindow[]; }

export interface ScenarioResult {
  name: string;
  trajectory: ForecastPoint[];
  minMoisture: number;
  finalMoisture: number;
  hoursBelowOptimal: number;
  hoursBelowWiltingPoint: number;
  /** Tích phân stress nước theo giờ (cùng định nghĩa waterStress của Twin Service): 1 = một giờ stress hoàn toàn. */
  stressHours: number;
  irrigationHours: number;
}

export interface WhatIfResult {
  scenarios: ScenarioResult[];
  /** Ít giờ dưới điểm héo nhất, rồi ít stress tích lũy nhất; chênh lệch stress nhỏ (< 0.05 giờ) coi là hòa và chọn lịch dùng ít nước hơn. */
  best: string | null;
}

export function whatIf(
  m0: number, params: Params, weather: HourlyWeather[], schedules: Schedule[],
  horizonHours: number, th: Thresholds,
): WhatIfResult {
  const scenarios = schedules.map<ScenarioResult>((s) => {
    const trajectory = forecast(m0, params, weather, s.windows, horizonHours, th.fieldCapacity);
    const ms = trajectory.map((p) => p.moisture);
    return {
      name: s.name,
      trajectory,
      minMoisture: Math.min(m0, ...ms),
      finalMoisture: ms[ms.length - 1] ?? m0,
      hoursBelowOptimal: ms.filter((m) => m < th.optimalLow).length,
      hoursBelowWiltingPoint: ms.filter((m) => m < th.wiltingPoint).length,
      stressHours: ms.reduce((a, m) => a + clamp((th.optimalLow - m) / (th.optimalLow - th.wiltingPoint), 0, 1), 0),
      irrigationHours: s.windows.reduce((a, w) => a + Math.max(0, Math.min(w.durationHours, horizonHours - Math.max(0, w.startHour))), 0),
    };
  });
  const ranked = [...scenarios].sort(
    (a, b) =>
      a.hoursBelowWiltingPoint - b.hoursBelowWiltingPoint ||
      (Math.abs(a.stressHours - b.stressHours) >= 0.05 ? a.stressHours - b.stressHours : 0) ||
      a.irrigationHours - b.irrigationHours,
  );
  return { scenarios, best: ranked[0]?.name ?? null };
}
