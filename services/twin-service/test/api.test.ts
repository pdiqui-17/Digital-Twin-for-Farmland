import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import client from "prom-client";
import { deriveThresholds } from "@digital-twin/shared";
import { createApp, createMetrics } from "../src/app";
import { TwinService } from "../src/service";
import { StaticZoneCatalog } from "../src/repositories/catalog";
import { InMemoryHistory, InMemoryTwinRepository } from "../src/repositories/memory";
import type { TwinReading } from "../src/domain/twin";

const now = new Date("2026-01-01T08:00:00Z");
// Ngưỡng mặc định 45-70%: 40% là "dry"
const rd = (o: Partial<TwinReading> = {}): TwinReading => ({
  sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: 40, unit: "percent",
  ts: now.toISOString(), quality: "ok", ...o,
});

let server: Server, base: string, service: TwinService, history: InMemoryHistory;
beforeEach(async () => {
  const registry = new client.Registry();
  const m = createMetrics(registry);
  history = new InMemoryHistory();
  service = new TwinService(new InMemoryTwinRepository(), {
    defaultFarmId: "farm-01", onApplied: () => m.applied.inc(), onDrop: (r) => m.dropped.inc({ reason: r }),
  });
  server = createApp({ service, history, registry }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe("REST", () => {
  it("healthz/readyz", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it("GET /zones/:id phản ánh dữ liệu vừa ingest; zone lạ trả 404", async () => {
    await service.ingest(rd(), now);
    const z = await (await fetch(`${base}/zones/zone-A`)).json();
    expect(z.metrics.soilMoisture).toBe(40);
    expect(z.status).toBe("dry");
    expect(z.farmId).toBe("farm-01");
    expect((await fetch(`${base}/zones/nope`)).status).toBe(404);
    expect((await (await fetch(`${base}/zones`)).json()).length).toBe(1);
  });

  it("history lọc theo metric/thời gian và kiểm tra tham số", async () => {
    for (let i = 0; i < 5; i++) history.append(rd({ ts: new Date(now.getTime() + i * 60000).toISOString(), value: 50 - i }));
    const from = new Date(now.getTime() + 2 * 60000).toISOString();
    const h = await (await fetch(`${base}/zones/zone-A/history?metric=soil_moisture&from=${from}`)).json();
    expect(h.points.map((p: { value: number }) => p.value)).toEqual([48, 47, 46]);
    expect(h.points[0].quality).toBe("ok");
    expect((await fetch(`${base}/zones/zone-A/history?metric=air_temp`)).status).toBe(400);
    expect((await fetch(`${base}/zones/zone-A/history?metric=air_temperature`)).status).toBe(200);
    expect((await fetch(`${base}/zones/zone-A/history?from=abc`)).status).toBe(400);
  });

  it("/metrics có counter và gauge trạng thái", async () => {
    await service.ingest(rd(), now);
    await service.ingest(rd(), now); // duplicate
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain("twin_readings_applied_total 1");
    expect(text).toContain('twin_readings_dropped_total{reason="duplicate"} 1');
    expect(text).toContain('twin_zone_status{zone="zone-A",status="dry"} 1');
  });
});

describe("SSE", () => {
  it("nhận event zone sau khi ingest", async () => {
    const res = await fetch(`${base}/stream?zone=zone-A`);
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    await service.ingest(rd({ zoneId: "zone-B" }), now); // bị lọc
    await service.ingest(rd(), now);
    const chunk = new TextDecoder().decode((await reader.read()).value);
    expect(chunk).toContain("event: zone");
    expect(chunk).toContain('"zoneId":"zone-A"');
    expect(chunk).not.toContain("zone-B");
    await reader.cancel();
  });
});

describe("TwinService", () => {
  it("ingest đồng thời nhiều reading cùng zone không mất dữ liệu", async () => {
    await Promise.all(
      ["a", "b", "c", "d"].map((id, i) => service.ingest(rd({ sensorId: id, value: 40 + i * 10 }), now)),
    );
    const z = (await service.getZone("zone-A"))!;
    expect(Object.keys(z.sensors).sort()).toEqual(["a", "b", "c", "d"]);
    expect(z.metrics.soilMoisture).toBe(55);
  });

  it("sweepStale đổi zone sang unknown và phát update", async () => {
    await service.ingest(rd({ value: 50 }), now);
    const events: string[] = [];
    service.on("update", (z) => events.push(z.status));
    const changed = await service.sweepStale(new Date(now.getTime() + 10 * 60000));
    expect(changed).toHaveLength(1);
    expect(events).toEqual(["unknown"]);
    expect(await service.sweepStale(new Date(now.getTime() + 11 * 60000))).toHaveLength(0);
  });

  it("lỗi repository được ném ra (để Kafka giao lại), không bị nuốt", async () => {
    const broken = new TwinService(
      { get: async () => null, list: async () => [], upsert: async () => { throw new Error("db down"); } },
      { defaultFarmId: "farm-01" },
    );
    await expect(broken.ingest(rd(), now)).rejects.toThrow("db down");
  });
});

describe("TwinService với danh mục zone", () => {
  const catalog = new StaticZoneCatalog([
    { zoneId: "zone-A", farmId: "farm-01", thresholds: deriveThresholds(45, 70) },
    { zoneId: "zone-B", farmId: "farm-01", thresholds: deriveThresholds(55, 80) },
  ]);

  it("ngưỡng lấy theo từng zone", async () => {
    const s = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "farm-01", catalog });
    await s.ingest(rd({ zoneId: "zone-A", value: 50 }), now);
    await s.ingest(rd({ zoneId: "zone-B", value: 50 }), now);
    expect((await s.getZone("zone-A"))!.status).toBe("ok");
    expect((await s.getZone("zone-B"))!.status).toBe("dry");
    expect((await s.getZone("zone-B"))!.thresholds.optimalLow).toBe(55);
  });

  it("zone ngoài danh mục bị bỏ (twin_state có khóa ngoại tới zones)", async () => {
    const drops: string[] = [];
    const s = new TwinService(new InMemoryTwinRepository(), { defaultFarmId: "farm-01", catalog, onDrop: (r) => drops.push(r) });
    expect(await s.ingest(rd({ zoneId: "zone-X" }), now)).toEqual({ applied: false, reason: "unknown_zone" });
    expect(await s.getZone("zone-X")).toBeNull();
    expect(drops).toEqual(["unknown_zone"]);
  });
});

describe("POST /ingest (dev)", () => {
  it("mặc định không tồn tại; bật devIngest thì nhận mảng reading và từ chối reading sai", async () => {
    expect((await fetch(`${base}/ingest`, { method: "POST" })).status).toBe(404);
    const s = createApp({ service, history, registry: new client.Registry(), devIngest: true }).listen(0);
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const post = (body: unknown) => fetch(`${b}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post([rd({ ts: new Date().toISOString() })]);
    expect(ok.status).toBe(200);
    expect((await ok.json()).results[0].applied).toBe(true);
    expect((await post([{ nonsense: true }])).status).toBe(400);
    expect((await post([rd({ type: "air_temp" as never })])).status).toBe(400);
    await new Promise<void>((r) => s.close(() => r()));
  });
});
