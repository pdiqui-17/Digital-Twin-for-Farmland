import { describe, it, expect } from "vitest";
import type { ValveCommandMessage } from "@digital-twin/shared";
import { TwinService } from "../../twin-service/src/service";
import { InMemoryTwinRepository } from "../../twin-service/src/repositories/memory";
import { Controller } from "../src/controller";
import { MemoryAlertStore, MemoryCommandStore } from "../src/adapters/memory";
import { at, TH } from "./helpers";

/** Simulator mini: đất khô dần, van mở thì ẩm tăng. */
class MiniField {
  moisture = 50; valveOpen = false; lastCommandId?: string;
  constructor(private evap = 0.12, private irrig = 0.6) {}
  step() { this.moisture += (this.valveOpen ? this.irrig : 0) - this.evap; }
}

interface Rig {
  twin: TwinService; store: MemoryCommandStore; alerts: MemoryAlertStore; field: MiniField;
  ctl: Controller; seen: number; trace: { min: number; m: number; open: boolean }[];
}

function rig(): Rig {
  const twin = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "farm-01" });
  const store = new MemoryCommandStore();
  const alerts = new MemoryAlertStore();
  return { twin, store, alerts, field: new MiniField(), ctl: newController(twin, store, alerts), seen: 0, trace: [] };
}

const newController = (twin: TwinService, store: MemoryCommandStore, alerts: MemoryAlertStore) =>
  new Controller({
    twin: { zones: () => twin.listZones() },
    commandPublisher: store, commandStore: store,
    alertStore: alerts, alertPublisher: alerts, notifier: alerts,
  });

async function step(r: Rig, min: number, lost = false) {
  const now = at(min);
  r.field.step();
  if (!lost) {
    await r.twin.ingest({ sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: r.field.moisture, unit: "percent", ts: now.toISOString(), quality: "ok" }, now);
  }
  await r.twin.sweepStale(now);
  await r.ctl.tick(now);
  // van "vật lý" nhận lệnh và phản hồi trạng thái (như simulator của Role A: kèm lastCommandId)
  for (const c of r.store.published.slice(r.seen) as ValveCommandMessage[]) {
    r.field.valveOpen = c.action === "open";
    r.field.lastCommandId = c.commandId;
    await r.twin.ingestValveState(c.zoneId, { state: r.field.valveOpen ? "open" : "closed", ts: now.toISOString(), lastCommandId: c.commandId }, c.farmId, now);
  }
  r.seen = r.store.published.length;
  r.trace.push({ min, m: r.field.moisture, open: r.field.valveOpen });
}

async function runLoop(minutes: number, opts: { dropDataBetween?: [number, number] } = {}) {
  const r = rig();
  for (let min = 0; min < minutes; min++) {
    const d = opts.dropDataBetween;
    await step(r, min, !!d && min >= d[0] && min < d[1]);
  }
  return r;
}

describe("closed loop: hạn hán -> cảnh báo -> tự tưới -> phục hồi", () => {
  it("mở van, đưa độ ẩm về mục tiêu, đóng van, đóng cảnh báo; không bao giờ xuống mức critical", async () => {
    const { store, alerts, trace } = await runLoop(240);
    const opens = store.commands.filter((c) => c.action === "open");
    const closes = store.commands.filter((c) => c.action === "close");

    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(closes.length).toBe(opens.length);                      // mỗi lần mở đều có lần đóng
    expect(store.commands.every((c) => (c.reason ?? "").length > 0)).toBe(true);
    expect(opens.every((c) => store.status.get(c.commandId) === "completed")).toBe(true);

    const dry = alerts.history.filter((e) => e.rule === "soil_dry").map((e) => e.state);
    expect(dry.slice(0, 2)).toEqual(["open", "closed"]);           // cảnh báo mở trước khi tưới rồi đóng sau khi phục hồi
    expect(alerts.history.some((e) => e.rule === "soil_critical")).toBe(false);

    expect(Math.min(...trace.map((t) => t.m))).toBeGreaterThan(TH.criticalBelow);
    expect(Math.max(...trace.map((t) => t.m))).toBeLessThan(TH.optimalHigh); // không tưới quá tay
  });

  it("mọi lệnh close đều được van xác nhận và chuyển sang completed (không treo ở sent)", async () => {
    const { store } = await runLoop(400);
    const closes = store.commands.filter((c) => c.action === "close");
    expect(closes.length).toBeGreaterThan(1);
    for (const c of closes) expect(store.status.get(c.commandId)).toBe("completed");
  });

  it("không bao giờ tưới liên tục: hai lần mở cách nhau tối thiểu minRest + thời gian tưới", async () => {
    const { store } = await runLoop(400);
    const opens = store.commands.filter((c) => c.action === "open").map((c) => Date.parse(c.ts));
    for (let i = 1; i < opens.length; i++) expect(opens[i]! - opens[i - 1]!).toBeGreaterThanOrEqual(3600_000);
  });

  it("mất dữ liệu cảm biến: phát zone_unknown, đóng van nếu đang tưới, cảnh báo đóng khi có dữ liệu lại", async () => {
    // Van mở khoảng phút 42; mất dữ liệu từ phút 50 (đang tưới) đến 80.
    const { store, alerts } = await runLoop(100, { dropDataBetween: [50, 80] });
    const close = store.commands.find((c) => c.action === "close");
    expect(close?.reason).toContain("mất dữ liệu");
    expect(alerts.history.some((e) => e.rule === "zone_unknown" && e.state === "open")).toBe(true);
    expect(alerts.history.some((e) => e.rule === "zone_unknown" && e.state === "closed")).toBe(true);
  });

  it("controller khởi động lại giữa lúc tưới: không gửi lệnh mở trùng, không mở trùng cảnh báo, vẫn đóng van đúng lúc", async () => {
    const r = rig();
    let min = 0;
    for (; !r.field.valveOpen; min++) await step(r, min); // chạy tới khi van mở
    await step(r, min++);                                   // tick kế tiếp: controller thấy ack -> watering
    r.ctl = newController(r.twin, r.store, r.alerts);       // "restart"
    await r.ctl.restore(at(min));
    expect(r.ctl.valvePhase("zone-A")).toBe("watering");
    for (const end = min + 60; min < end; min++) await step(r, min);
    expect(r.store.commands.filter((c) => c.action === "open")).toHaveLength(1);
    expect(r.store.commands.filter((c) => c.action === "close")).toHaveLength(1);
    expect(r.alerts.history.filter((e) => e.rule === "soil_dry" && e.state === "open")).toHaveLength(1);
  });

  it("van không phản hồi: báo ack_timeout, gửi lệnh đóng an toàn, không gửi lệnh mở lặp lại", async () => {
    const twin = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "farm-01" });
    const store = new MemoryCommandStore(); const alerts = new MemoryAlertStore();
    const ctl = newController(twin, store, alerts);
    for (let min = 0; min < 20; min++) {
      const now = at(min);
      await twin.ingest({ sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: 40, unit: "percent", ts: now.toISOString(), quality: "ok" }, now);
      await ctl.tick(now);
    }
    const open = store.commands.filter((c) => c.action === "open");
    expect(open).toHaveLength(1);
    expect(store.status.get(open[0]!.commandId)).toBe("failed");
    const close = store.commands.filter((c) => c.action === "close");
    expect(close).toHaveLength(1);
    // Van "chết" cũng không xác nhận lệnh đóng an toàn: lệnh close bị đánh dấu failed.
    expect(store.status.get(close[0]!.commandId)).toBe("failed");
    expect(alerts.history.some((e) => e.rule === "valve_ack_timeout" && e.state === "open")).toBe(true);
  });
});
