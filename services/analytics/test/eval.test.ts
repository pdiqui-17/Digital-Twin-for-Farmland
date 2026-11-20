import { describe, it, expect } from "vitest";
import { DEFAULT_THRESHOLDS as th } from "@farm/shared";
import { calibrate, type Sample } from "../src/domain/calibrate";
import { parseCsv, resample, splitByTime } from "../src/domain/dataset";
import { evaluate, formatTable, mae, rmse } from "../src/domain/evaluate";
import { generateSynthetic } from "../src/domain/synthetic";
import { OpenMeteoProvider } from "../src/domain/weather";
import { simulate, type Params } from "../src/domain/waterBalance";

describe("metrics", () => {
  it("MAE/RMSE", () => {
    expect(mae([1, -1, 2, -2])).toBe(1.5);
    expect(rmse([3, 4])).toBeCloseTo(Math.sqrt(12.5));
  });
});

describe("evaluate", () => {
  it("mô hình đúng trên dữ liệu không nhiễu thì sai số ~0 và thắng baseline", () => {
    const p: Params = { evapBase: 0.2, evapPerC: 0.01, irrigGain: 3, rainGain: 1.5 };
    const inputs = Array.from({ length: 120 }, (_, i) => ({ temp: 25 + 5 * Math.sin(i / 4), rain: i % 17 === 0 ? 2 : 0, open: (i % 9 < 2 ? 1 : 0) as 0 | 1 }));
    const traj = [30, ...simulate(30, p, inputs, 1, 40)];
    const test: Sample[] = inputs.map((u, i) => ({ tsMs: i * 3_600_000, moisture: traj[i]!, ...u }));
    const rows = evaluate(test, p, 1, 40, [1, 6]);
    expect(rows[1]!.model.mae).toBeLessThan(1e-9);
    expect(rows[1]!.persistence.mae).toBeGreaterThan(0.5);
  });

  it("dữ liệu tổng hợp lệch cấu trúc: mô hình fit từ train thắng persistence ở 6h trên test", () => {
    const { train, test } = splitByTime(generateSynthetic(21 * 24), 0.7);
    const fit = calibrate(train, th.fieldCapacity);
    const rows = evaluate(test, fit.params, 1, th.fieldCapacity, [1, 6]);
    expect(rows[1]!.n).toBeGreaterThan(50);
    expect(rows[1]!.model.mae).toBeLessThan(rows[1]!.persistence.mae);
    expect(Number.isFinite(rows[0]!.model.rmse)).toBe(true);
    expect(formatTable(rows)).toContain("| 6h |");
  });
});

describe("dataset", () => {
  it("resample dùng giá trị quan sát gần nhất không muộn hơn mốc lưới", () => {
    const rows: Sample[] = [
      { tsMs: 0, moisture: 30, temp: 20, rain: 0, open: 0 },
      { tsMs: 50 * 60_000, moisture: 28, temp: 22, rain: 0, open: 1 },
      { tsMs: 130 * 60_000, moisture: 25, temp: 24, rain: 0, open: 0 },
    ];
    const out = resample(rows, 60);
    expect(out.map((s) => s.tsMs / 60_000)).toEqual([0, 60, 120]);
    expect(out.map((s) => s.moisture)).toEqual([30, 28, 28]);
  });
  it("parseCsv bỏ dòng hỏng", () => {
    const s = parseCsv("ts,moisture,temp,rain,open\n2026-01-01T00:00:00Z,30,25,0,1\nbad,line\n2026-01-01T01:00:00Z,29,25,0,0");
    expect(s).toHaveLength(2);
    expect(s[0]!.open).toBe(1);
  });
  it("splitByTime giữ thứ tự", () => {
    const { train, test } = splitByTime([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.7);
    expect(train).toEqual([1, 2, 3, 4, 5, 6, 7]); expect(test).toEqual([8, 9, 10]);
  });
});

describe("OpenMeteoProvider", () => {
  const now = Date.parse("2026-01-01T10:30:00Z");
  const body = {
    hourly: {
      time: ["2026-01-01T09:00", "2026-01-01T10:00", "2026-01-01T11:00", "2026-01-01T12:00"],
      temperature_2m: [20, 21, 22, null], precipitation: [0, 0, 1.5, 0.2],
    },
  };
  const mkFetch = (ok = true) => { let calls = 0; const f = (async () => { calls++; return { ok, status: ok ? 200 : 500, json: async () => body }; }) as unknown as typeof fetch; return { f, calls: () => calls }; };

  it("bỏ giờ đã qua, thay null bằng mặc định, và cache lần gọi thứ hai", async () => {
    const { f, calls } = mkFetch();
    const p = new OpenMeteoProvider(f, 60_000, () => now);
    const a = await p.hourly(21, 105, 2);
    expect(a[0]).toEqual({ temp: 21, rain: 0 });   // giờ 10:00 kết thúc 11:00 > 10:30 nên còn hiệu lực
    expect(a[1]).toEqual({ temp: 22, rain: 1.5 });
    await p.hourly(21, 105, 2);
    expect(calls()).toBe(1);
  });
  it("lỗi HTTP ném lỗi", async () => {
    await expect(new OpenMeteoProvider(mkFetch(false).f, 60_000, () => now).hourly(21, 105, 2)).rejects.toThrow();
  });
});
