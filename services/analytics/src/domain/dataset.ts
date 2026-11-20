import type { Sample } from "./calibrate";

/**
 * Đưa dữ liệu không đều về lưới đều `stepMin` phút bằng last-observation-carried-forward
 * (mỗi bước lấy quan sát gần nhất không muộn hơn mốc lưới).
 */
export function resample(rows: Sample[], stepMin: number): Sample[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.tsMs - b.tsMs);
  const step = stepMin * 60_000;
  const out: Sample[] = [];
  let j = 0;
  for (let t = Math.ceil(sorted[0]!.tsMs / step) * step; t <= sorted[sorted.length - 1]!.tsMs; t += step) {
    while (j + 1 < sorted.length && sorted[j + 1]!.tsMs <= t) j++;
    out.push({ ...sorted[j]!, tsMs: t });
  }
  return out;
}

/** CSV: ts,moisture,temp,rain,open  (dòng đầu là header). Bỏ qua dòng hỏng. */
export function parseCsv(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const [ts, m, t, r, o] = line.split(",");
    const s: Sample = { tsMs: Date.parse(ts ?? ""), moisture: Number(m), temp: Number(t), rain: Number(r), open: Number(o) ? 1 : 0 };
    if ([s.tsMs, s.moisture, s.temp, s.rain].every(Number.isFinite)) out.push(s);
  }
  return out;
}

/** Chia theo thời gian (không xáo trộn) để tránh rò rỉ thông tin tương lai. */
export function splitByTime<T>(rows: T[], trainFrac = 0.7): { train: T[]; test: T[] } {
  const k = Math.floor(rows.length * trainFrac);
  return { train: rows.slice(0, k), test: rows.slice(k) };
}
