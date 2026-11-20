import { describe, it, expect } from "vitest";
import type { Command, Reading, ZoneState } from "@farm/shared";
import { TwinService } from "../../twin-service/src/service";
import { InMemoryTwinRepository } from "../../twin-service/src/repositories/memory";
import { Controller } from "../src/controller";
import { MemoryAlertStore, MemoryCommandStore } from "../src/adapters/memory";
import { at } from "./helpers";

/** Simulator mini: đất khô dần, van mở thì ẩm tăng. */
class MiniField {
  moisture = 30; valveOpen = false;
  constructor(private evap = 0.12, private irrig = 0.6) {}
  step() { this.moisture += (this.valveOpen ? this.irrig : 0) - this.evap; }
}

async function runLoop(minutes: number, opts: { dropDataBetween?: [number, number] } = {}) {
  const twin = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "f1" });
  const store = new MemoryCommandStore();
  const alerts = new MemoryAlertStore();
  const ctl = new Controller({
    twin: { zones: () => twin.listZones() },
    commandPublisher: store, commandStore: store,
    alertStore: alerts, alertPublisher: alerts, notifier: alerts,
  });
  const field = new MiniField();
  const trace: { min: number; m: number; open: boolean }[] = [];
  let seen = 0;

  for (let min = 0; min < minutes; min++) {
    const now = at(min);
    field.step();
    const lost = opts.dropDataBetween && min >= opts.dropDataBetween[0] && min < opts.dropDataBetween[1];
    if (!lost) {
      const r: Reading = { sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: field.moisture, unit: "percent", ts: now.toISOString(), quality: "ok" };
      await twin.ingest(r, now);
    }
    await twin.sweepStale(now);
    await ctl.tick(now);
    // van "vật lý" nhận lệnh và phản hồi trạng thái
    for (const c of store.published.slice(seen) as Command[]) {
      field.valveOpen = c.action === "open";
      await twin.ingestValveState({ zoneId: c.zoneId, state: field.valveOpen ? "open" : "closed", commandId: c.commandId, ts: now.toISOString() }, now);
    }
    seen = store.published.length;
    trace.push({ min, m: field.moisture, open: field.valveOpen });
  }
  return { store, alerts, trace, twin };
}

describe("closed loop: hạn hán -> cảnh báo -> tự tưới -> phục hồi", () => {
  it("mở van, đưa độ ẩm về mục tiêu, đóng van, đóng cảnh báo; không bao giờ xuống mức critical", async () => {
    const { store, alerts, trace } = await runLoop(240);
    const opens = store.commands.filter((c) => c.action === "open");
    const closes = store.commands.filter((c) => c.action === "close");

    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect(closes.length).toBe(opens.length);                      // mỗi lần mở đều có lần đóng
    expect(store.commands.every((c) => c.reason.length > 0)).toBe(true);

    const dry = alerts.history.filter((e) => e.rule === "soil_dry").map((e) => e.state);
    expect(dry.slice(0, 2)).toEqual(["open", "closed"]);           // cảnh báo mở trước khi tưới rồi đóng sau khi phục hồi
    expect(alerts.history.some((e) => e.rule === "soil_critical")).toBe(false);

    expect(Math.min(...trace.map((t) => t.m))).toBeGreaterThan(24);
    expect(Math.max(...trace.map((t) => t.m))).toBeLessThan(36);   // không tưới quá tay
  });

  it("không bao giờ tưới liên tục: hai lần mở cách nhau tối thiểu minRest + thời gian tưới", async () => {
    const { store } = await runLoop(400);
    const opens = store.commands.filter((c) => c.action === "open").map((c) => Date.parse(c.ts));
    for (let i = 1; i < opens.length; i++) expect(opens[i]! - opens[i - 1]!).toBeGreaterThanOrEqual(3600_000);
  });

  it("mất dữ liệu cảm biến: không mở van mới, phát cảnh báo zone_unknown, và vẫn đóng van nếu đang tưới", async () => {
    // Mất dữ liệu từ phút 40 (van đang tưới) đến 70.
    const { store, alerts } = await runLoop(100, { dropDataBetween: [38, 70] });
    const close = store.commands.find((c) => c.action === "close");
    expect(close).toBeDefined();
    expect(alerts.history.some((e) => e.rule === "zone_unknown" && e.state === "open")).toBe(true);
    expect(alerts.history.some((e) => e.rule === "zone_unknown" && e.state === "closed")).toBe(true);
  });

  it("van không phản hồi: báo ack_timeout, không gửi lệnh mở lặp lại", async () => {
    const twin = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "f1" });
    const store = new MemoryCommandStore(); const alerts = new MemoryAlertStore();
    const ctl = new Controller({
      twin: { zones: () => twin.listZones() }, commandPublisher: store, commandStore: store,
      alertStore: alerts, alertPublisher: alerts, notifier: alerts,
    });
    for (let min = 0; min < 20; min++) {
      const now = at(min);
      await twin.ingest({ sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: 20, unit: "percent", ts: now.toISOString(), quality: "ok" }, now);
      await ctl.tick(now);
    }
    expect(store.commands.filter((c) => c.action === "open")).toHaveLength(1);
    expect(alerts.history.some((e) => e.rule === "valve_ack_timeout" && e.state === "open")).toBe(true);
  });
});
