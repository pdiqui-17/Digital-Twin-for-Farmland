import { leastSquares } from "./linalg";
import { PARAM_NAMES, type ParamName, type Params } from "./waterBalance";

export interface Sample {
  tsMs: number;
  moisture: number;
  temp: number;
  rain: number;     // mm/h
  /** Phần thời gian van mở trong bước, 0..1 (dữ liệu từ lịch tưới hoặc DB). */
  open: number;
}

export interface CalibrationResult {
  params: Params;
  /** RMSE của Δ độ ẩm một bước trên tập fit (đơn vị %). */
  rmseDelta: number;
  nRows: number;
  /** Tham số không xác định được từ dữ liệu (ví dụ chưa từng tưới) -> đặt 0. */
  unidentified: ParamName[];
}

const featureRow = (s: Sample, dt: number): Record<ParamName, number> => ({
  evapBase: -dt,
  evapPerC: -s.temp * dt,
  irrigGain: s.open * dt,
  rainGain: s.rain * dt,
});

/**
 * Fit 4 hệ số bằng bình phương tối thiểu trên Δm. Ràng buộc hệ số >= 0 bằng active-set đơn giản:
 * hệ số âm nhất bị loại rồi fit lại. Dòng có độ ẩm chạm sức chứa ruộng bị bỏ (nước thoát, mô hình tuyến tính không đúng).
 */
export function calibrate(samples: Sample[], fieldCapacity: number, maxGapHours = 3): CalibrationResult {
  const rows: { f: Record<ParamName, number>; y: number }[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!, b = samples[i + 1]!;
    const dt = (b.tsMs - a.tsMs) / 3_600_000;
    if (dt <= 0 || dt > maxGapHours) continue;
    if (b.moisture >= fieldCapacity - 0.2 || a.moisture >= fieldCapacity - 0.2) continue;
    rows.push({ f: featureRow(a, dt), y: b.moisture - a.moisture });
  }

  const unidentified: ParamName[] = [];
  let active: ParamName[] = PARAM_NAMES.filter((n) => {
    const nonZero = rows.some((r) => Math.abs(r.f[n]) > 1e-9);
    if (!nonZero) unidentified.push(n);
    return nonZero;
  });

  let coef: Partial<Record<ParamName, number>> = {};
  while (active.length && rows.length >= active.length) {
    const X = rows.map((r) => active.map((n) => r.f[n]));
    const y = rows.map((r) => r.y);
    const beta = leastSquares(X, y);
    const worst = beta.reduce((wi, v, i) => (v < beta[wi]! ? i : wi), 0);
    if (beta[worst]! >= 0) { coef = Object.fromEntries(active.map((n, i) => [n, beta[i]!])); break; }
    active = active.filter((_, i) => i !== worst);
  }

  const params: Params = {
    evapBase: coef.evapBase ?? 0, evapPerC: coef.evapPerC ?? 0,
    irrigGain: coef.irrigGain ?? 0, rainGain: coef.rainGain ?? 0,
  };
  for (const n of PARAM_NAMES) if (!unidentified.includes(n) && coef[n] === undefined) unidentified.push(n);

  const sse = rows.reduce((s, r) => {
    const pred = PARAM_NAMES.reduce((a, n) => a + params[n] * r.f[n], 0);
    return s + (r.y - pred) ** 2;
  }, 0);
  return { params, rmseDelta: rows.length ? Math.sqrt(sse / rows.length) : NaN, nRows: rows.length, unidentified };
}
