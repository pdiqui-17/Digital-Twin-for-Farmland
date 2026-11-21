import { clamp } from "@digital-twin/shared";

/**
 * Mô hình cân bằng nước (xấp xỉ, hệ số được FIT từ dữ liệu, không lấy từ simulator):
 *   m(t+dt) = m(t) + dt * ( -(evapBase + evapPerC * T) + irrigGain * open + rainGain * rain )
 * Đơn vị: m (%VWC), dt (giờ), T (°C), rain (mm/h), open (0..1, phần thời gian van mở).
 */
export interface Params {
  evapBase: number;   // %/giờ
  evapPerC: number;   // %/giờ/°C
  irrigGain: number;  // %/giờ khi van mở
  rainGain: number;   // % trên mỗi mm mưa
}
export const PARAM_NAMES = ["evapBase", "evapPerC", "irrigGain", "rainGain"] as const;
export type ParamName = (typeof PARAM_NAMES)[number];

/** open: phần thời gian van mở trong bước, 0..1. */
export interface Input { temp: number; rain: number; open: number; }

export const DEFAULT_PARAMS: Params = { evapBase: 0.2, evapPerC: 0.01, irrigGain: 3, rainGain: 1.5 };

export function step(m: number, p: Params, u: Input, dtHours: number, fieldCapacity: number): number {
  const d = -(p.evapBase + p.evapPerC * u.temp) + p.irrigGain * u.open + p.rainGain * u.rain;
  return clamp(m + dtHours * d, 0, fieldCapacity);
}

/** Trả về quỹ đạo m1..mN (không gồm m0). */
export function simulate(m0: number, p: Params, inputs: Input[], dtHours: number, fieldCapacity: number): number[] {
  const out: number[] = [];
  let m = m0;
  for (const u of inputs) { m = step(m, p, u, dtHours, fieldCapacity); out.push(m); }
  return out;
}
