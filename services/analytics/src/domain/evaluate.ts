import { simulate, type Params } from "./waterBalance";
import type { Sample } from "./calibrate";

export const mae = (e: number[]) => e.reduce((a, b) => a + Math.abs(b), 0) / e.length;
export const rmse = (e: number[]) => Math.sqrt(e.reduce((a, b) => a + b * b, 0) / e.length);

export interface HorizonScore { horizonSteps: number; n: number; model: Score; persistence: Score; linearTrend: Score; }
export interface Score { mae: number; rmse: number; }

const score = (errs: number[]): Score => ({ mae: mae(errs), rmse: rmse(errs) });

/**
 * Đánh giá rolling-origin trên tập test: tại mỗi điểm gốc, dự đoán h bước tới rồi so với thực tế.
 * Mô hình được cấp đầu vào THỰC TẾ của tương lai (nhiệt độ, mưa, van): đo chất lượng mô hình nước,
 * không đo chất lượng dự báo thời tiết.
 * Baseline: persistence (giữ giá trị cuối) và linear-trend (ngoại suy xu hướng `trendWindow` bước gần nhất).
 */
export function evaluate(
  test: Sample[], params: Params, dtHours: number, fieldCapacity: number,
  horizons: number[] = [1, 3, 6], stride = 1, trendWindow = 6,
): HorizonScore[] {
  return horizons.map((h) => {
    const em: number[] = [], ep: number[] = [], el: number[] = [];
    for (let i = trendWindow; i + h < test.length; i += stride) {
      const truth = test[i + h]!.moisture;
      const m0 = test[i]!.moisture;
      const inputs = test.slice(i, i + h).map((s) => ({ temp: s.temp, rain: s.rain, open: s.open }));
      const pred = simulate(m0, params, inputs, dtHours, fieldCapacity)[h - 1]!;
      const slope = (m0 - test[i - trendWindow]!.moisture) / trendWindow;
      em.push(pred - truth); ep.push(m0 - truth); el.push(m0 + slope * h - truth);
    }
    return { horizonSteps: h, n: em.length, model: score(em), persistence: score(ep), linearTrend: score(el) };
  });
}

export function formatTable(rows: HorizonScore[], unit = "h"): string {
  const f = (s: Score) => `${s.mae.toFixed(2)} / ${s.rmse.toFixed(2)}`;
  const head = `| Horizon | n | Model MAE/RMSE | Persistence | Linear trend |\n|---|---|---|---|---|`;
  return [head, ...rows.map((r) => `| ${r.horizonSteps}${unit} | ${r.n} | ${f(r.model)} | ${f(r.persistence)} | ${f(r.linearTrend)} |`)].join("\n");
}
