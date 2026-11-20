import { clamp } from "@farm/shared";
import type { Sample } from "./calibrate";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Dữ liệu tổng hợp để thử pipeline hiệu chỉnh/đánh giá. Cố ý KHÁC cấu trúc mô hình Analytics
 * (bay hơi phụ thuộc độ ẩm, hiệu quả tưới giảm khi đất đã ẩm, có nhiễu) để sai số không đẹp giả tạo.
 * Đây KHÔNG phải simulator của role A, chỉ để kiểm thử khi chưa có dữ liệu thật.
 */
export function generateSynthetic(hours: number, seed = 42, fieldCapacity = 40): Sample[] {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const start = Date.parse("2026-01-01T00:00:00Z");
  const out: Sample[] = [];
  let m = 32, openLeft = 0, rainLeft = 0;
  for (let h = 0; h < hours; h++) {
    const temp = 24 + 7 * Math.sin((2 * Math.PI * ((h % 24) - 9)) / 24) + 0.8 * gauss();
    if (rainLeft === 0 && rnd() < 0.01) rainLeft = 1 + Math.floor(rnd() * 3);
    const rain = rainLeft > 0 ? 1 + 3 * rnd() : 0;
    if (rainLeft > 0) rainLeft--;
    if (openLeft === 0 && m < 27) openLeft = 2;
    const open: 0 | 1 = openLeft > 0 ? 1 : 0;
    if (openLeft > 0) openLeft--;

    out.push({ tsMs: start + h * 3_600_000, moisture: m + 0.1 * gauss(), temp, rain, open });

    const evap = (0.18 + 0.012 * temp) * (0.5 + 0.5 * clamp((m - 12) / 20, 0, 1));
    const irrig = open ? 3.2 * (1 - (m / fieldCapacity) ** 2) : 0;
    m = clamp(m - evap + irrig + 1.2 * rain + 0.12 * gauss(), 5, fieldCapacity);
  }
  return out;
}
