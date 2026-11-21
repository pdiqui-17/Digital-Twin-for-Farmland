import { describe, it, expect } from "vitest";
import { deriveThresholds } from "@digital-twin/shared";
import { classifyStatus, fungalConditions, fungalRisk, nextFungalAccum, waterStress } from "../src/domain/derived";

// tối ưu 45-70% -> dry < 45, critical < 35, điểm héo 25
const th = deriveThresholds(45, 70);

describe("waterStress", () => {
  it("0 khi đủ ẩm, 1 khi dưới điểm héo, tuyến tính ở giữa", () => {
    expect(waterStress(60, th)).toBe(0);
    expect(waterStress(45, th)).toBe(0);
    expect(waterStress(35, th)).toBeCloseTo(0.5);
    expect(waterStress(25, th)).toBe(1);
    expect(waterStress(5, th)).toBe(1);
  });
  it("null khi không có dữ liệu", () => expect(waterStress(null, th)).toBeNull());
});

describe("classifyStatus", () => {
  it("phân loại theo ngưỡng, biên thuộc nhóm tốt hơn", () => {
    expect(classifyStatus(null, th)).toBe("unknown");
    expect(classifyStatus(34.9, th)).toBe("critical");
    expect(classifyStatus(35, th)).toBe("dry");
    expect(classifyStatus(44.9, th)).toBe("dry");
    expect(classifyStatus(45, th)).toBe("ok");
  });
});

describe("fungal", () => {
  it("điều kiện cần cả ẩm cao và nhiệt độ ôn hòa", () => {
    expect(fungalConditions(90, 20)).toBe(true);
    expect(fungalConditions(80, 20)).toBe(false);
    expect(fungalConditions(90, 35)).toBe(false);
    expect(fungalConditions(null, 20)).toBe(false);
  });
  it("tích lũy tăng, giảm nhanh gấp đôi, không âm, có trần", () => {
    expect(nextFungalAccum(0, 10, true)).toBe(10);
    expect(nextFungalAccum(30, 10, false)).toBe(10);
    expect(nextFungalAccum(5, 10, false)).toBe(0);
    expect(nextFungalAccum(715, 30, true)).toBe(720);
    expect(fungalRisk(180)).toBeCloseTo(0.5);
    expect(fungalRisk(720)).toBe(1);
  });
});
