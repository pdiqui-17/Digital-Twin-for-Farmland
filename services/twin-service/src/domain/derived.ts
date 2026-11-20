import { clamp, type Thresholds, type ZoneStatus } from "@farm/shared";

/** Stress nước 0..1: 0 khi độ ẩm >= optimalLow, 1 khi <= wiltingPoint, tuyến tính ở giữa. */
export function waterStress(moisture: number | null, th: Thresholds): number | null {
  if (moisture === null) return null;
  return clamp((th.optimalLow - moisture) / (th.optimalLow - th.wiltingPoint), 0, 1);
}

/** Điều kiện thuận lợi cho nấm: ẩm không khí cao và nhiệt độ ôn hòa. */
export function fungalConditions(rh: number | null, temp: number | null): boolean {
  return rh !== null && temp !== null && rh >= 85 && temp >= 15 && temp <= 28;
}

export const FUNGAL_FULL_RISK_MIN = 360; // 6 giờ liên tục = rủi ro tối đa
export const FUNGAL_MAX_ACCUM_MIN = 720;

/** Cộng dồn phút "ẩm ướt"; khi điều kiện hết thì giảm nhanh gấp đôi tốc độ tăng. */
export function nextFungalAccum(prev: number, dtMin: number, favourable: boolean): number {
  const next = favourable ? prev + dtMin : prev - 2 * dtMin;
  return clamp(next, 0, FUNGAL_MAX_ACCUM_MIN);
}

export const fungalRisk = (accumMin: number) => clamp(accumMin / FUNGAL_FULL_RISK_MIN, 0, 1);

export function classifyStatus(moisture: number | null, th: Thresholds): ZoneStatus {
  if (moisture === null) return "unknown";
  if (moisture < th.criticalBelow) return "critical";
  if (moisture < th.dryBelow) return "dry";
  return "ok";
}
