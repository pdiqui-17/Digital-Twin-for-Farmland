import { describe, it, expect } from "vitest";
import { TwinAlertEventSchema } from "@digital-twin/shared";
import { defaultRules, emptyBook, evaluateAlerts, restoreBook } from "../src/domain/alerts";
import { at, zone } from "./helpers";

// Zone tối ưu 45-70%: soil_dry mở < 45, đóng >= 49; soil_critical mở < 35, đóng >= 39.
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
    const { events } = run(emptyBook(), [44.9, 45.1, 44.9, 45.2, 44.5, 46, 45.5]);
    expect(events.filter((e) => e.rule === "soil_dry")).toEqual([{ rule: "soil_dry", state: "open", min: 0 }]);
  });

  it("chỉ đóng khi vượt ngưỡng đóng (dryBelow + 4)", () => {
    const { events } = run(emptyBook(), [42, 48.9, 49]);
    expect(events.filter((e) => e.rule === "soil_dry").map((e) => e.state)).toEqual(["open", "closed"]);
    expect(events.find((e) => e.state === "closed")!.min).toBe(2);
  });

  it("critical mở cùng dry khi độ ẩm rất thấp", () => {
    const { events } = run(emptyBook(), [30]);
    expect(events.map((e) => e.rule).sort()).toEqual(["soil_critical", "soil_dry"]);
  });

  it("sự kiện hợp lệ theo hợp đồng: có farmId, category, vòng đời cùng alertId", () => {
    const a = evaluateAlerts(emptyBook(), zone({ moisture: 42 }), rules, at(0));
    const b = evaluateAlerts(a.book, zone({ moisture: 50 }), rules, at(1));
    const [open] = a.events, [closed] = b.events;
    expect(TwinAlertEventSchema.safeParse(open).success).toBe(true);
    expect(open).toMatchObject({ farmId: "farm-01", category: "water_stress", state: "open", value: 42 });
    expect(closed).toMatchObject({ alertId: open!.alertId, state: "closed" });
    // Nội dung lúc đóng nói sự cố đã hết, không lặp lại câu "đang khô" của lúc mở.
    expect(closed!.message).toContain("đã đủ ẩm trở lại");
    expect(closed!.message).not.toContain("đang khô");
  });

  it("cooldown chặn mở lại ngay sau khi vừa đóng", () => {
    const first = run(emptyBook(), [42, 50]);               // mở phút 0, đóng phút 1
    const again = run(first.book, [42], 5, 600);            // phút 5: còn trong cooldown 10 phút
    expect(again.events.filter((e) => e.rule === "soil_dry")).toHaveLength(0);
    const later = run(first.book, [42], 20, 600);           // phút 20: hết cooldown
    expect(later.events.filter((e) => e.rule === "soil_dry")).toHaveLength(1);
  });

  it("mất dữ liệu kéo dài >= 60 s sinh zone_unknown, và không đụng luật độ ẩm", () => {
    const { events } = run(emptyBook(), [null, null]);      // phút 0: chờ xác nhận, phút 1: mở
    expect(events).toEqual([{ rule: "zone_unknown", state: "open", min: 1 }]);
  });

  it("có dữ liệu trở lại thì zone_unknown đóng", () => {
    const { events } = run(emptyBook(), [null, null, 50]);
    expect(events.filter((e) => e.rule === "zone_unknown").map((e) => e.state)).toEqual(["open", "closed"]);
  });

  it("cảm biến lỗi kéo dài (theo cờ quality của Processor) mở rồi đóng sensor_fault", () => {
    const a0 = evaluateAlerts(emptyBook(), zone({ faulty: ["s-A-moisture"] }), rules, at(0));
    expect(a0.events).toHaveLength(0);                       // chưa đủ 15 s
    const a = evaluateAlerts(a0.book, zone({ faulty: ["s-A-moisture"] }), rules, at(1));
    expect(a.events).toHaveLength(1);
    expect(a.events[0]).toMatchObject({ rule: "sensor_fault", category: "sensor_fault", state: "open" });
    expect(a.events[0]!.message).toContain("s-A-moisture");
    const b = evaluateAlerts(a.book, zone({ faulty: [] }), rules, at(2));
    expect(b.events.map((e) => e.state)).toEqual(["closed"]);
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

describe("thời gian xác nhận (confirmSec)", () => {
  const sec = (s: number) => new Date(at(0).getTime() + s * 1000);
  /** Chạy theo giây: mỗi phần tử là [giây, zone]. */
  const runSec = (steps: [number, ReturnType<typeof zone>][]) => {
    let b = emptyBook(); const events: { rule: string; state: string; s: number }[] = [];
    for (const [s, z] of steps) {
      const r = evaluateAlerts(b, z, rules, sec(s));
      b = r.book; r.events.forEach((e) => events.push({ rule: e.rule, state: e.state, s }));
    }
    return { book: b, events };
  };
  const ok = zone({ moisture: 50 });
  const faulty = zone({ moisture: 50, faulty: ["s-C-moisture"] });

  it("lỗi cảm biến chỉ một tick (5 s) KHÔNG sinh cảnh báo", () => {
    const { events, book } = runSec([[0, ok], [5, faulty], [10, ok], [15, ok]]);
    expect(events).toEqual([]);
    expect(book.pending).toEqual({});
  });

  it("lỗi kéo dài 3 tick (>= 15 s) thì mở sensor_fault đúng một lần", () => {
    const { events } = runSec([[0, faulty], [5, faulty], [10, faulty], [15, faulty], [20, faulty]]);
    expect(events).toEqual([{ rule: "sensor_fault", state: "open", s: 15 }]);
  });

  it("hai lỗi thoáng qua rời nhau không cộng dồn thành cảnh báo", () => {
    const { events } = runSec([[0, faulty], [5, faulty], [10, ok], [15, faulty], [20, faulty], [25, ok]]);
    expect(events).toEqual([]);
  });

  it("khoảng trống dữ liệu lúc khởi động (~20 s) không sinh zone_unknown", () => {
    const unknown = zone({ moisture: null });
    const { events } = runSec([[0, unknown], [5, unknown], [10, unknown], [15, unknown], [20, unknown], [25, ok]]);
    expect(events).toEqual([]);
  });

  it("confirmSec = 0 thì mở ngay (cấu hình CTRL_*_CONFIRM_SEC=0)", () => {
    const r = evaluateAlerts(emptyBook(), faulty, defaultRules({ sensorFaultSec: 0, zoneUnknownSec: 0 }), sec(0));
    expect(r.events.map((e) => e.rule)).toEqual(["sensor_fault"]);
  });

  it("luật độ ẩm không có confirmSec vẫn mở ngay", () => {
    const { events } = runSec([[0, zone({ moisture: 42 })]]);
    expect(events).toEqual([{ rule: "soil_dry", state: "open", s: 0 }]);
  });
});

describe("restoreBook", () => {
  it("cảnh báo còn mở trong DB không bị mở trùng sau restart, và đóng đúng alertId cũ", () => {
    const book = restoreBook([{ alertId: "old-1", zoneId: "zone-A", rule: "soil_dry", ts: at(0).toISOString() }]);
    expect(evaluateAlerts(book, zone({ moisture: 42 }), rules, at(1)).events).toHaveLength(0);
    const closed = evaluateAlerts(book, zone({ moisture: 50 }), rules, at(2)).events;
    expect(closed).toEqual([expect.objectContaining({ alertId: "old-1", state: "closed" })]);
  });
});
