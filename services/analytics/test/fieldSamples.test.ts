import { describe, it, expect } from "vitest";
import { buildFieldSamples, openIntervalsFromCommands, type OpenInterval, type RawReading } from "../src/domain/fieldSamples";
import { calibrate } from "../src/domain/calibrate";
import { parseCsv } from "../src/domain/dataset";

const T0 = Date.parse("2026-11-21T05:00:00Z");
const sec = (s: number) => T0 + s * 1000;

/** Bản tin độ ẩm + nhiệt độ mỗi `everySec` giây thật trong `totalSec` giây thật. */
function readings(totalSec: number, everySec: number, m: (s: number) => number, t: (s: number) => number): RawReading[] {
  const out: RawReading[] = [];
  for (let s = 0; s < totalSec; s += everySec) {
    out.push({ tsMs: sec(s), type: "soil_moisture", value: m(s) });
    out.push({ tsMs: sec(s), type: "air_temperature", value: t(s) });
  }
  return out;
}

describe("buildFieldSamples", () => {
  it("quy giờ thật ra giờ ruộng: 10 phút thật ở 60 lần = 10 mẫu, mỗi mẫu cách 1 giờ ruộng", () => {
    const s = buildFieldSamples(readings(600, 5, () => 50, () => 20), [], { timeScale: 60 });
    expect(s).toHaveLength(10);
    expect(s[1]!.tsMs - s[0]!.tsMs).toBe(3_600_000);
    expect(s.every((x) => x.rain === 0 && x.open === 0 && x.moisture === 50)).toBe(true);
  });

  it("open = phần thời gian van mở, đo từ giữa bước này tới giữa bước sau", () => {
    // 60 lần: 1 giờ ruộng = 60 s thật. Bước 0 = [0,60), cửa sổ open của nó = [30,90).
    const iv: OpenInterval[] = [{ startMs: sec(30), endMs: sec(60) }];
    const s = buildFieldSamples(readings(180, 5, () => 50, () => 20), iv, { timeScale: 60 });
    expect(s[0]!.open).toBeCloseTo(0.5);
    expect(s[1]!.open).toBe(0);
  });

  it("bước thiếu độ ẩm hoặc nhiệt độ bị bỏ", () => {
    const r = readings(120, 5, () => 50, () => 20).filter((x) => !(x.type === "air_temperature" && x.tsMs >= sec(60)));
    expect(buildFieldSamples(r, [], { timeScale: 60 })).toHaveLength(1);
  });
});

describe("openIntervalsFromCommands", () => {
  const cmd = (action: "open" | "close", s: number, status = "completed", ackS: number | null = null, durationSec: number | null = null) =>
    ({ action, status, tsMs: sec(s), ackMs: ackS === null ? null : sec(ackS), durationSec });

  it("mở từ lúc van xác nhận tới lệnh close kế tiếp", () => {
    expect(openIntervalsFromCommands([cmd("open", 0, "completed", 2, 60), cmd("close", 20)])).toEqual([{ startMs: sec(2), endMs: sec(20) }]);
  });
  it("không có close: kết thúc khi hết durationSec (simulator tự đóng)", () => {
    expect(openIntervalsFromCommands([cmd("open", 0, "completed", 1, 6)])).toEqual([{ startMs: sec(1), endMs: sec(7) }]);
  });
  it("bỏ lệnh open failed hoặc chưa được xác nhận", () => {
    expect(openIntervalsFromCommands([cmd("open", 0, "failed", null, 6), cmd("open", 30, "sent", null, 6)])).toEqual([]);
  });
});

describe("đầu cuối: dữ liệu giờ thật ở 300 lần -> mẫu giờ ruộng -> calibrate tìm lại hệ số", () => {
  it("khôi phục bay hơi và hiệu quả tưới gần đúng", () => {
    // Cánh đồng giả, tính theo giờ ruộng: dm/dt = -(0.4 + 0.03 T) + 8 * open  (%/giờ)
    const scale = 300, everySec = 1;           // 1 s thật = 5 phút ruộng
    const totalSec = 60 * 60;                  // 60 phút thật = 300 giờ ruộng
    const temp = (s: number) => 22 + 6 * Math.sin((2 * Math.PI * s * scale) / 86_400); // chu kỳ ngày theo giờ ruộng
    const valveOpen = (s: number) => Math.floor((s * scale) / 3600) % 10 < 2;          // tưới 2 giờ ruộng mỗi 10 giờ
    let m = 50; const ms: number[] = [];
    for (let s = 0; s < totalSec; s += everySec) {
      ms.push(m);
      const dtH = (everySec * scale) / 3600;
      m += dtH * (-(0.4 + 0.03 * temp(s)) + 8 * (valveOpen(s) ? 1 : 0));
    }
    const r = readings(totalSec, everySec, (s) => ms[s / everySec]!, temp);
    const intervals: OpenInterval[] = [];
    for (let s = 0; s < totalSec; s += everySec) if (valveOpen(s)) intervals.push({ startMs: sec(s), endMs: sec(s + everySec) });

    const samples = buildFieldSamples(r, intervals, { timeScale: scale });
    expect(samples.length).toBeGreaterThan(290);
    const fit = calibrate(samples, 100);
    expect(fit.params.irrigGain).toBeCloseTo(8, 0);
    // bay hơi trung bình ở 22 °C
    expect(fit.params.evapBase + fit.params.evapPerC * 22).toBeCloseTo(0.4 + 0.03 * 22, 1);
  });
});

describe("parseCsv", () => {
  it("open nhận giá trị lẻ 0..1 và bị kẹp trong khoảng", () => {
    const s = parseCsv("ts,moisture,temp,rain,open\n2026-11-21T00:00:00Z,50,20,0,0.25\n2026-11-21T01:00:00Z,50,20,0,3");
    expect(s.map((x) => x.open)).toEqual([0.25, 1]);
  });
});
