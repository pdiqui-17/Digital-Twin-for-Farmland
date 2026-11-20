import { describe, it, expect } from "vitest";
import { Reading, parseMqttTopic, mqttTopics } from "../src";

describe("Reading schema", () => {
  it("parse ví dụ mục 3.4 và gán quality mặc định", () => {
    const r = Reading.parse({
      sensorId: "s-A1", zoneId: "zone-A", type: "soil_moisture",
      value: 38.5, unit: "percent", ts: "2026-01-01T08:00:00Z",
    });
    expect(r.quality).toBe("ok");
  });
  it("từ chối loại sensor lạ và NaN", () => {
    expect(() => Reading.parse({ sensorId: "x", zoneId: "z", type: "foo", value: 1, unit: "u", ts: "2026-01-01T08:00:00Z" })).toThrow();
    expect(() => Reading.parse({ sensorId: "x", zoneId: "z", type: "rain", value: NaN, unit: "u", ts: "2026-01-01T08:00:00Z" })).toThrow();
  });
});

describe("MQTT topics", () => {
  it("dựng rồi parse lại cho kết quả khớp", () => {
    expect(parseMqttTopic(mqttTopics.telemetry("f1", "zone-A", "s-A1"))).toEqual({
      farmId: "f1", zoneId: "zone-A", kind: "telemetry", sensorId: "s-A1",
    });
    expect(parseMqttTopic(mqttTopics.valveState("f1", "zone-A"))?.kind).toBe("valveState");
    expect(parseMqttTopic(mqttTopics.valveCmd("f1", "zone-A"))?.kind).toBe("valveCmd");
  });
  it("topic lạ trả null", () => {
    expect(parseMqttTopic("foo/bar")).toBeNull();
    expect(parseMqttTopic("farm/f1/zone/z1/sensor/s1/other")).toBeNull();
  });
});
