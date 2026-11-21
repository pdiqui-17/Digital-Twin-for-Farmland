import type { Sample } from "./calibrate";

/** Một bản tin đã làm sạch từ sensor_readings (giờ THẬT). */
export interface RawReading { tsMs: number; type: string; value: number; }
/** Khoảng van mở theo giờ THẬT (từ bảng commands). */
export interface OpenInterval { startMs: number; endMs: number; }

export interface FieldSampleOptions {
  /** Số giây ruộng trong 1 giây thật (simTimeScale). */
  timeScale: number;
  /** Độ dài một bước, tính bằng phút ruộng. Mặc định 60 (mô hình dùng bước 1 giờ). */
  stepFieldMin?: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Tổng thời gian (ms) các khoảng mở giao với [a, b). */
function overlapMs(intervals: OpenInterval[], a: number, b: number): number {
  let s = 0;
  for (const iv of intervals) s += Math.max(0, Math.min(b, iv.endMs) - Math.max(a, iv.startMs));
  return Math.min(s, b - a);
}

/**
 * Gom bản tin giờ thật thành mẫu theo bước đều của giờ RUỘNG cho mô hình cân bằng nước.
 *
 * - Trục thời gian: giờ ruộng = t0 + (giờ thật - t0) × timeScale, t0 = bản tin đầu tiên.
 *   Một bước `stepFieldMin` phút ruộng ứng với stepFieldMin/timeScale phút thật.
 * - moisture, temp: trung bình độ ẩm đất / nhiệt độ không khí trong bước. Bước thiếu một trong hai bị bỏ;
 *   calibrate tự bỏ cặp mẫu cách nhau quá xa (vd. simulator dừng rồi chạy lại).
 * - open: phần thời gian van mở trong khoảng TỪ GIỮA bước này TỚI GIỮA bước sau. Hiệu của hai trung bình
 *   liên tiếp phản ánh đúng khoảng đó, nên tưới được gán khớp với thay đổi độ ẩm nó gây ra.
 * - rain: 0. Pipeline không có số đo mưa; chỉ nên dùng dữ liệu lúc simulator bật hạn hán.
 */
export function buildFieldSamples(readings: RawReading[], intervals: OpenInterval[], opts: FieldSampleOptions): Sample[] {
  if (!readings.length || !(opts.timeScale > 0)) return [];
  const stepFieldMs = (opts.stepFieldMin ?? 60) * 60_000;
  const stepRealMs = stepFieldMs / opts.timeScale;
  const sorted = [...readings].sort((a, b) => a.tsMs - b.tsMs);
  const t0 = sorted[0]!.tsMs;

  const buckets = new Map<number, { m: number[]; t: number[] }>();
  for (const r of sorted) {
    const k = Math.floor((r.tsMs - t0) / stepRealMs);
    const b = buckets.get(k) ?? { m: [], t: [] };
    if (r.type === "soil_moisture") b.m.push(r.value);
    else if (r.type === "air_temperature") b.t.push(r.value);
    buckets.set(k, b);
  }

  const out: Sample[] = [];
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const b = buckets.get(k)!;
    const moisture = mean(b.m), temp = mean(b.t);
    if (moisture === null || temp === null) continue;
    const from = t0 + (k + 0.5) * stepRealMs;
    out.push({
      tsMs: t0 + k * stepFieldMs,
      moisture, temp, rain: 0,
      open: overlapMs(intervals, from, from + stepRealMs) / stepRealMs,
    });
  }
  return out;
}

/** Dòng lệnh trong bảng commands cần để dựng khoảng van mở. */
export interface CommandRow { action: "open" | "close"; status: string; tsMs: number; ackMs: number | null; durationSec: number | null; }

/**
 * Khoảng van mở thật từ lịch sử lệnh của MỘT zone (giờ thật): bắt đầu khi van xác nhận lệnh open
 * (acknowledged_at, nếu thiếu thì lúc gửi), kết thúc ở lệnh close kế tiếp hoặc khi hết durationSec (simulator tự đóng),
 * lấy mốc nào sớm hơn. Lệnh open bị failed (van không mở) bị bỏ.
 */
export function openIntervalsFromCommands(rows: CommandRow[]): OpenInterval[] {
  const sorted = [...rows].sort((a, b) => a.tsMs - b.tsMs);
  const out: OpenInterval[] = [];
  sorted.forEach((c, i) => {
    if (c.action !== "open" || c.status === "failed" || c.status === "sent") return;
    const start = c.ackMs ?? c.tsMs;
    const nextClose = sorted.slice(i + 1).find((x) => x.action === "close")?.tsMs ?? Infinity;
    const autoClose = c.durationSec ? start + c.durationSec * 1000 : Infinity;
    const end = Math.min(nextClose, autoClose);
    if (Number.isFinite(end) && end > start) out.push({ startMs: start, endMs: end });
  });
  return out;
}
