import { describe, it, expect } from "vitest";
import type { Reading } from "@farm/shared";
import { applyReading, applyValveState, initZone, refresh } from "../src/domain/twin";

const t0 = Date.parse("2026-01-01T08:00:00Z");
const at = (min: number) => new Date(t0 + min * 60_000);
const rd = (over: Partial<Reading> & { min: number }): Reading => ({
  sensorId: "s1", zoneId: "z1", type: "soil_moisture", value: 35, unit: "percent",
  quality: "ok", ts: at(over.min).toISOString(), ...over,
});

describe("applyReading", () => {
  it("reading đầu tiên tạo metrics và status", () => {
    const r = applyReading(initZone("z1", "f1", at(0)), rd({ min: 0, value: 35 }), at(0));
    expect(r.applied).toBe(true);
    expect(r.state.metrics.soilMoisture).toBe(35);
    expect(r.state.status).toBe("ok");
    expect(r.state.derived.waterStress).toBe(0);
  });

  it("trùng ts thì duplicate, ts cũ hơn thì out_of_order, state không đổi", () => {
    const s1 = applyReading(initZone("z1", "f1", at(0)), rd({ min: 5, value: 35 }), at(5)).state;
    const dup = applyReading(s1, rd({ min: 5, value: 10 }), at(6));
    const old = applyReading(s1, rd({ min: 1, value: 10 }), at(6));
    expect(dup).toMatchObject({ applied: false, reason: "duplicate" });
    expect(old).toMatchObject({ applied: false, reason: "out_of_order" });
    expect(dup.state).toBe(s1);
    expect(old.state.metrics.soilMoisture).toBe(35);
  });

  it("áp lại cùng một chuỗi message (Kafka giao lại) cho kết quả như nhau", () => {
    const seq = [rd({ min: 0, value: 30 }), rd({ min: 1, value: 29 }), rd({ min: 2, value: 28 })];
    let a = initZone("z1", "f1", at(0));
    for (const r of seq) a = applyReading(a, r, at(2)).state;
    let b = a;
    for (const r of seq) b = applyReading(b, r, at(2)).state;
    expect(b.metrics).toEqual(a.metrics);
    expect(b.sensors).toEqual(a.sensors);
  });

  it("reading ở tương lai quá xa bị loại", () => {
    const r = applyReading(initZone("z1", "f1", at(0)), rd({ min: 60 }), at(0));
    expect(r).toMatchObject({ applied: false, reason: "future_ts" });
  });

  it("sensor quality=bad được ghi vào snapshot nhưng không ảnh hưởng chỉ số", () => {
    const s1 = applyReading(initZone("z1", "f1", at(0)), rd({ min: 0, value: 35 }), at(0)).state;
    const r = applyReading(s1, rd({ min: 1, sensorId: "s2", value: 2, quality: "bad" }), at(1));
    expect(r).toMatchObject({ applied: false, reason: "bad_quality" });
    expect(r.state.sensors["s2"]?.quality).toBe("bad");
    expect(r.state.metrics.soilMoisture).toBe(35);
  });

  it("nhiều sensor cùng loại lấy trung bình", () => {
    let s = initZone("z1", "f1", at(0));
    s = applyReading(s, rd({ min: 0, sensorId: "a", value: 20 }), at(0)).state;
    s = applyReading(s, rd({ min: 0, sensorId: "b", value: 30 }), at(0)).state;
    expect(s.metrics.soilMoisture).toBe(25);
    expect(s.status).toBe("dry");
  });

  it("nguy cơ nấm tăng khi ẩm cao + ôn hòa kéo dài, rồi giảm khi hết điều kiện", () => {
    let s = initZone("z1", "f1", at(0));
    for (let m = 0; m <= 240; m += 2) {
      s = applyReading(s, rd({ min: m, sensorId: "h", type: "air_humidity", unit: "percent", value: 92 }), at(m)).state;
      s = applyReading(s, rd({ min: m, sensorId: "t", type: "air_temp", unit: "celsius", value: 22 }), at(m)).state;
    }
    const high = s.derived.fungalRisk;
    expect(high).toBeGreaterThan(0.5); // ~240 phút / 360
    for (let m = 242; m <= 300; m += 2) {
      s = applyReading(s, rd({ min: m, sensorId: "h", type: "air_humidity", unit: "percent", value: 50 }), at(m)).state;
    }
    expect(s.derived.fungalRisk).toBeLessThan(high);
  });
});

describe("refresh / stale", () => {
  it("quá staleAfterSec không có dữ liệu thì zone thành unknown", () => {
    const s = applyReading(initZone("z1", "f1", at(0)), rd({ min: 0, value: 35 }), at(0)).state;
    expect(refresh(s, at(4)).status).toBe("ok");
    const stale = refresh(s, at(6));
    expect(stale.status).toBe("unknown");
    expect(stale.metrics.soilMoisture).toBeNull();
    expect(stale.derived.waterStress).toBeNull();
  });
});

describe("applyValveState", () => {
  it("bỏ qua trạng thái van cũ hơn", () => {
    const s0 = initZone("z1", "f1", at(0));
    const s1 = applyValveState(s0, { zoneId: "z1", state: "open", ts: at(5).toISOString() });
    const s2 = applyValveState(s1, { zoneId: "z1", state: "closed", ts: at(1).toISOString() });
    expect(s2.valve.state).toBe("open");
  });
});
