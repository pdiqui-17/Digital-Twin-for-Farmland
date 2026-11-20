import { describe, it, expect } from "vitest";
import { defaultRules, emptyBook, evaluateAlerts } from "../src/domain/alerts";
import { at, zone } from "./helpers";

const rules = defaultRules();
const run = (book = emptyBook(), vals: (number | null)[], startMin = 0, cooldown = 600) => {
  let b = book; const events: { rule: string; state: string; min: number }[] = [];
  vals.forEach((v, i) => {
    const r = evaluateAlerts(b, zone({ moisture: v }), rules, at(startMin + i), cooldown);
    b = r.book; r.events.forEach((e) => events.push({ rule: e.rule, state: e.state, min: startMin + i }));
  });
  return { book: b, events };
};

describe("evaluateAlerts", () => {
  it("dao động quanh ngưỡng chỉ sinh MỘT cảnh báo mở (hysteresis)", () => {
    const { events } = run(emptyBook(), [27.9, 28.1, 27.9, 28.2, 27.5, 29, 28.5]);
    expect(events.filter((e) => e.rule === "soil_dry")).toEqual([{ rule: "soil_dry", state: "open", min: 0 }]);
  });

  it("chỉ đóng khi vượt ngưỡng đóng (dryBelow + 4)", () => {
    const { events } = run(emptyBook(), [25, 31.9, 32]);
    expect(events.filter((e) => e.rule === "soil_dry").map((e) => e.state)).toEqual(["open", "closed"]);
    expect(events.find((e) => e.state === "closed")!.min).toBe(2);
  });

  it("critical mở cùng dry khi độ ẩm rất thấp", () => {
    const { events } = run(emptyBook(), [20]);
    expect(events.map((e) => e.rule).sort()).toEqual(["soil_critical", "soil_dry"]);
  });

  it("cooldown chặn mở lại ngay sau khi vừa đóng", () => {
    const first = run(emptyBook(), [25, 33]);               // mở phút 0, đóng phút 1
    const again = run(first.book, [25], 5, 600);            // phút 5: còn trong cooldown 10 phút
    expect(again.events.filter((e) => e.rule === "soil_dry")).toHaveLength(0);
    const later = run(first.book, [25], 20, 600);           // phút 20: hết cooldown
    expect(later.events.filter((e) => e.rule === "soil_dry")).toHaveLength(1);
  });

  it("mất dữ liệu sinh zone_unknown, và không đụng luật độ ẩm", () => {
    const { events } = run(emptyBook(), [null]);
    expect(events.map((e) => e.rule)).toEqual(["zone_unknown"]);
  });

  it("có dữ liệu trở lại thì zone_unknown đóng", () => {
    const { events } = run(emptyBook(), [null, 35]);
    expect(events.filter((e) => e.rule === "zone_unknown").map((e) => e.state)).toEqual(["open", "closed"]);
  });

  it("nguy cơ nấm có hysteresis 0.7 / 0.4", () => {
    let b = emptyBook(); const out: string[] = [];
    for (const f of [0.5, 0.75, 0.6, 0.45, 0.3]) {
      const r = evaluateAlerts(b, zone({ fungal: f }), rules, at(out.length));
      b = r.book; r.events.filter((e) => e.rule === "fungal_risk").forEach((e) => out.push(e.state));
    }
    expect(out).toEqual(["open", "closed"]);
  });
});
