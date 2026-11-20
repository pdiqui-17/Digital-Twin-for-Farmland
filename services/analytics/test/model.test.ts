import { describe, it, expect } from "vitest";
import { DEFAULT_THRESHOLDS as th } from "@farm/shared";
import { solve, leastSquares } from "../src/domain/linalg";
import { simulate, step, type Params, type Input } from "../src/domain/waterBalance";
import { calibrate, type Sample } from "../src/domain/calibrate";
import { forecast, scheduleToOpen } from "../src/domain/forecast";
import { whatIf } from "../src/domain/whatif";
import { mulberry32 } from "../src/domain/synthetic";

describe("linalg", () => {
  it("giải hệ 2x2", () => {
    const x = solve([[2, 1], [1, 3]], [5, 10]);
    expect(x[0]).toBeCloseTo(1); expect(x[1]).toBeCloseTo(3);
  });
  it("ma trận suy biến ném lỗi", () => expect(() => solve([[1, 2], [2, 4]], [1, 2])).toThrow());
  it("leastSquares khôi phục đường thẳng y = 2x + 1", () => {
    const X = [0, 1, 2, 3, 4].map((x) => [1, x]);
    const b = leastSquares(X, [1, 3, 5, 7, 9]);
    expect(b[0]).toBeCloseTo(1, 5); expect(b[1]).toBeCloseTo(2, 5);
  });
});

describe("waterBalance", () => {
  const zero: Params = { evapBase: 0, evapPerC: 0, irrigGain: 0, rainGain: 0 };
  const u: Input = { temp: 30, rain: 0, open: 0 };
  it("hệ số 0 thì độ ẩm giữ nguyên", () => expect(simulate(30, zero, [u, u, u], 1, 40)).toEqual([30, 30, 30]));
  it("bay hơi làm giảm, tưới làm tăng, mưa làm tăng", () => {
    const p: Params = { evapBase: 0.2, evapPerC: 0.01, irrigGain: 3, rainGain: 1.5 };
    expect(step(30, p, u, 1, 40)).toBeCloseTo(30 - 0.5);
    expect(step(30, p, { ...u, open: 1 }, 1, 40)).toBeCloseTo(30 - 0.5 + 3);
    expect(step(30, p, { ...u, rain: 2 }, 1, 40)).toBeCloseTo(30 - 0.5 + 3);
  });
  it("không vượt sức chứa ruộng và không âm", () => {
    const p: Params = { evapBase: 0, evapPerC: 0, irrigGain: 50, rainGain: 0 };
    expect(step(30, p, { ...u, open: 1 }, 1, 40)).toBe(40);
    expect(step(1, { ...zero, evapBase: 5 }, u, 1, 40)).toBe(0);
  });
});

/**
 * Dữ liệu từ đúng cấu trúc tuyến tính + nhiễu. Van có phản hồi (mở khi khô, đóng khi ẩm) để độ ẩm ở trong vùng
 * tuyến tính; khi vẫn ra khỏi vùng thì reset và chèn khoảng trống 10 giờ (calibrate phải bỏ qua cặp đó).
 */
function linearData(truth: Params, n: number, seed: number, irrigate = true): Sample[] {
  const r = mulberry32(seed);
  const out: Sample[] = []; let m = 30, t = 0;
  for (let i = 0; i < n; i++) {
    const temp = 20 + 10 * r();
    const rain = r() < 0.1 ? 1 + 2 * r() : 0;
    const open: 0 | 1 = irrigate && (m < 26 || (m < 32 && r() < 0.4)) ? 1 : 0;
    out.push({ tsMs: t, moisture: m, temp, rain, open });
    m += -(truth.evapBase + truth.evapPerC * temp) + truth.irrigGain * open + truth.rainGain * rain + 0.03 * (r() - 0.5);
    t += 3_600_000;
    if (m > 37 || m < 20) { m = 30; t += 10 * 3_600_000; }
  }
  return out;
}

describe("calibrate", () => {
  const truth: Params = { evapBase: 0.15, evapPerC: 0.012, irrigGain: 2.4, rainGain: 1.1 };
  const evapAt = (p: Params, T: number) => p.evapBase + p.evapPerC * T;

  it("khôi phục các đại lượng xác định được từ dữ liệu có nhiễu", () => {
    const fit = calibrate(linearData(truth, 3000, 7), 40);
    expect(fit.unidentified).toEqual([]);
    // evapBase và evapPerC gần cộng tuyến khi T chỉ trong 20-30°C: kiểm tra bay hơi tổng hợp tại nhiệt độ điển hình.
    expect(evapAt(fit.params, 25)).toBeCloseTo(evapAt(truth, 25), 1);
    expect(fit.params.irrigGain).toBeCloseTo(truth.irrigGain, 1);
    expect(fit.params.rainGain).toBeCloseTo(truth.rainGain, 1);
    expect(fit.rmseDelta).toBeLessThan(0.05);
  });
  it("chưa từng tưới thì irrigGain không xác định (=0), bay hơi vẫn fit đúng", () => {
    const fit = calibrate(linearData(truth, 2000, 9, false), 40);
    expect(fit.unidentified).toContain("irrigGain");
    expect(fit.params.irrigGain).toBe(0);
    expect(evapAt(fit.params, 25)).toBeCloseTo(evapAt(truth, 25), 1);
  });
  it("hệ số luôn không âm dù dữ liệu ngược chiều", () => {
    // độ ẩm tăng đều không do tưới/mưa -> bay hơi fit ra âm -> phải bị ép về 0
    const data: Sample[] = Array.from({ length: 50 }, (_, i) => ({ tsMs: i * 3_600_000, moisture: 20 + 0.1 * i, temp: 25, rain: 0, open: 0 }));
    const fit = calibrate(data, 40);
    for (const v of Object.values(fit.params)) expect(v).toBeGreaterThanOrEqual(0);
  });
  it("bỏ qua cặp mẫu cách nhau quá xa", () => {
    const data: Sample[] = [
      { tsMs: 0, moisture: 30, temp: 25, rain: 0, open: 0 },
      { tsMs: 10 * 3_600_000, moisture: 5, temp: 25, rain: 0, open: 0 },
    ];
    expect(calibrate(data, 40).nRows).toBe(0);
  });
});

describe("forecast & what-if", () => {
  const p: Params = { evapBase: 0.2, evapPerC: 0.01, irrigGain: 3, rainGain: 1.5 };
  const w = Array.from({ length: 24 }, () => ({ temp: 30, rain: 0 }));

  it("scheduleToOpen đánh dấu đúng giờ và cắt theo horizon", () => {
    expect(scheduleToOpen([{ startHour: 1, durationHours: 2 }, { startHour: 5, durationHours: 10 }], 7)).toEqual([0, 1, 1, 0, 0, 1, 1]);
  });
  it("không tưới thì giảm đều; có tưới thì cao hơn", () => {
    const dry = forecast(30, p, w, [], 6, 40);
    const wet = forecast(30, p, w, [{ startHour: 0, durationHours: 2 }], 6, 40);
    expect(dry[5]!.moisture).toBeCloseTo(30 - 6 * 0.5);
    expect(wet[5]!.moisture).toBeGreaterThan(dry[5]!.moisture);
    expect(dry).toHaveLength(6);
  });
  it("what-if: chọn lịch tránh được điểm héo, hòa thì ít nước hơn", () => {
    const r = whatIf(22, p, w, [
      { name: "không tưới", windows: [] },
      { name: "tưới sớm 2h", windows: [{ startHour: 0, durationHours: 2 }] },
      { name: "tưới sớm 4h", windows: [{ startHour: 0, durationHours: 4 }] },
    ], 24, th);
    const by = Object.fromEntries(r.scenarios.map((s) => [s.name, s]));
    expect(by["không tưới"]!.hoursBelowWiltingPoint).toBeGreaterThan(by["tưới sớm 2h"]!.hoursBelowWiltingPoint);
    expect(by["tưới sớm 4h"]!.finalMoisture).toBeGreaterThan(by["tưới sớm 2h"]!.finalMoisture);
    expect(r.best).not.toBe("không tưới");
    expect(by["tưới sớm 2h"]!.irrigationHours).toBe(2);
  });
  it("hai lịch tưới khác nhau cho kết quả khác nhau (yêu cầu API what-if của tuần 6)", () => {
    const r = whatIf(26, p, w, [
      { name: "A", windows: [{ startHour: 0, durationHours: 1 }] },
      { name: "B", windows: [{ startHour: 6, durationHours: 3 }] },
    ], 12, th);
    expect(r.scenarios[0]!.trajectory).not.toEqual(r.scenarios[1]!.trajectory);
  });
});
