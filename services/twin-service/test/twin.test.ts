import { describe, it, expect } from "vitest";
import { deriveThresholds } from "@digital-twin/shared";
import { applyReading, applyValveState, initZone, refresh, withThresholds, type TwinReading } from "../src/domain/twin";

// zone kiểu zone-A trong seed: tối ưu 45-70% -> dry < 45, critical < 35, điểm héo 25
const th = deriveThresholds(45, 70);
const t0 = Date.parse("2026-01-01T08:00:00Z");
const at = (min: number) => new Date(t0 + min * 60_000);
const rd = (over: Partial<TwinReading> & { min: number }): TwinReading => ({
  sensorId: "s1", zoneId: "z1", type: "soil_moisture", value: 50, unit: "percent",
  quality: "ok", ts: at(over.min).toISOString(), ...over,
});
const zone = () => initZone("z1", "f1", at(0), th);

describe("applyReading", () => {
  it("reading đầu tiên tạo metrics và status", () => {
    const r = applyReading(zone(), rd({ min: 0, value: 50 }), at(0));
    expect(r.applied).toBe(true);
    expect(r.state.metrics.soilMoisture).toBe(50);
    expect(r.state.status).toBe("ok");
    expect(r.state.derived.waterStress).toBe(0);
  });

  it("trùng ts thì duplicate, ts cũ hơn thì out_of_order, state không đổi", () => {
    const s1 = applyReading(zone(), rd({ min: 5, value: 50 }), at(5)).state;
    const dup = applyReading(s1, rd({ min: 5, value: 10 }), at(6));
    const old = applyReading(s1, rd({ min: 1, value: 10 }), at(6));
    expect(dup).toMatchObject({ applied: false, reason: "duplicate" });
    expect(old).toMatchObject({ applied: false, reason: "out_of_order" });
    expect(dup.state).toBe(s1);
    expect(old.state.metrics.soilMoisture).toBe(50);
  });

  it("áp lại cùng một chuỗi message (Kafka giao lại) cho kết quả như nhau", () => {
    const seq = [rd({ min: 0, value: 50 }), rd({ min: 1, value: 49 }), rd({ min: 2, value: 48 })];
    let a = zone();
    for (const r of seq) a = applyReading(a, r, at(2)).state;
    let b = a;
    for (const r of seq) b = applyReading(b, r, at(2)).state;
    expect(b.metrics).toEqual(a.metrics);
    expect(b.sensors).toEqual(a.sensors);
  });

  it("reading ở tương lai quá xa bị loại", () => {
    const r = applyReading(zone(), rd({ min: 60 }), at(0));
    expect(r).toMatchObject({ applied: false, reason: "future_ts" });
  });

  it.each(["out_of_range", "stuck", "missing_signal"] as const)(
    "quality=%s được ghi vào snapshot, đánh dấu sensor lỗi, không ảnh hưởng chỉ số",
    (quality) => {
      const s1 = applyReading(zone(), rd({ min: 0, value: 50 }), at(0)).state;
      const r = applyReading(s1, rd({ min: 1, sensorId: "s2", value: 135, quality }), at(1));
      expect(r).toMatchObject({ applied: false, reason: "sensor_fault" });
      expect(r.state.sensors["s2"]?.quality).toBe(quality);
      expect(r.state.faultySensors).toEqual(["s2"]);
      expect(r.state.metrics.soilMoisture).toBe(50);
    },
  );

  it("sensor hồi phục (bản tin ok mới hơn) thì hết bị đánh dấu lỗi", () => {
    let s = applyReading(zone(), rd({ min: 0, quality: "stuck" }), at(0)).state;
    expect(s.faultySensors).toEqual(["s1"]);
    s = applyReading(s, rd({ min: 1, value: 51 }), at(1)).state;
    expect(s.faultySensors).toEqual([]);
    expect(s.metrics.soilMoisture).toBe(51);
  });

  it("noisy_smoothed vẫn là giá trị dùng được", () => {
    const r = applyReading(zone(), rd({ min: 0, value: 47, quality: "noisy_smoothed" }), at(0));
    expect(r.applied).toBe(true);
    expect(r.state.metrics.soilMoisture).toBe(47);
  });

  it("nhiều sensor cùng loại lấy trung bình; ngưỡng theo zone", () => {
    let s = zone();
    s = applyReading(s, rd({ min: 0, sensorId: "a", value: 35 }), at(0)).state;
    s = applyReading(s, rd({ min: 0, sensorId: "b", value: 45 }), at(0)).state;
    expect(s.metrics.soilMoisture).toBe(40);
    expect(s.status).toBe("dry");
    expect(s.derived.waterStress).toBeCloseTo(0.25);
  });

  it("nguy cơ nấm tăng khi ẩm cao + ôn hòa kéo dài, rồi giảm khi hết điều kiện", () => {
    let s = zone();
    for (let m = 0; m <= 240; m += 2) {
      s = applyReading(s, rd({ min: m, sensorId: "h", type: "air_humidity", unit: "percent", value: 92 }), at(m)).state;
      s = applyReading(s, rd({ min: m, sensorId: "t", type: "air_temperature", unit: "celsius", value: 22 }), at(m)).state;
    }
    const high = s.derived.fungalRisk;
    expect(high).toBeGreaterThan(0.5); // ~240 phút / 360
    for (let m = 242; m <= 300; m += 2) {
      s = applyReading(s, rd({ min: m, sensorId: "h", type: "air_humidity", unit: "percent", value: 50 }), at(m)).state;
    }
    expect(s.derived.fungalRisk).toBeLessThan(high);
  });

  it("simulator nhanh 60 lần: 6 phút thật ẩm liên tục = 6 giờ ruộng, nguy cơ nấm đạt tối đa", () => {
    const sec = (s: number) => new Date(t0 + s * 1000);
    const r = (s: number, sensorId: string, type: "air_humidity" | "air_temperature", value: number): TwinReading =>
      ({ sensorId, zoneId: "z1", type, value, unit: type === "air_humidity" ? "percent" : "celsius", quality: "ok", ts: sec(s).toISOString() });
    let real = zone(), scaled = zone();
    for (let s = 0; s <= 6 * 60; s += 5) { // bản tin mỗi 5 s thật, trong 6 phút thật
      for (const rd of [r(s, "h", "air_humidity", 92), r(s, "t", "air_temperature", 22)]) {
        real = applyReading(real, rd, sec(s)).state;
        scaled = applyReading(scaled, rd, sec(s), 60).state;
      }
    }
    expect(real.derived.fungalRisk).toBeLessThan(0.05);   // không tính tỉ lệ: chỉ ~6 phút
    expect(scaled.derived.fungalRisk).toBeCloseTo(1, 2);  // có tỉ lệ: ~360 phút ruộng
  });
});

describe("refresh / stale", () => {
  it("quá staleAfterSec không có dữ liệu thì zone thành unknown", () => {
    const s = applyReading(zone(), rd({ min: 0, value: 50 }), at(0)).state;
    expect(refresh(s, at(4)).status).toBe("ok");
    const stale = refresh(s, at(6));
    expect(stale.status).toBe("unknown");
    expect(stale.metrics.soilMoisture).toBeNull();
    expect(stale.derived.waterStress).toBeNull();
  });

  it("sensor lỗi quá hạn không còn bị liệt kê", () => {
    const s = applyReading(zone(), rd({ min: 0, quality: "missing_signal" }), at(0)).state;
    expect(refresh(s, at(6)).faultySensors).toEqual([]);
  });
});

describe("withThresholds", () => {
  it("đổi ngưỡng thì tính lại status", () => {
    const s = applyReading(zone(), rd({ min: 0, value: 50 }), at(0)).state;
    expect(withThresholds(s, deriveThresholds(55, 80), at(0)).status).toBe("dry");
  });
});

describe("applyValveState", () => {
  it("bỏ qua trạng thái van cũ hơn, giữ lastCommandId", () => {
    const s1 = applyValveState(zone(), { state: "open", ts: at(5).toISOString(), lastCommandId: "c1" });
    const s2 = applyValveState(s1, { state: "closed", ts: at(1).toISOString() });
    expect(s2.valve).toEqual({ state: "open", ts: at(5).toISOString(), lastCommandId: "c1" });
  });
});
