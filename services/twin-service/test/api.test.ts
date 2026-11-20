import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import client from "prom-client";
import type { Reading } from "@farm/shared";
import { createApp, createMetrics } from "../src/app";
import { TwinService } from "../src/service";
import { InMemoryHistory, InMemoryTwinRepository } from "../src/repositories/memory";

const now = new Date("2026-01-01T08:00:00Z");
const rd = (o: Partial<Reading> = {}): Reading => ({
  sensorId: "s1", zoneId: "zone-A", type: "soil_moisture", value: 26, unit: "percent",
  ts: now.toISOString(), quality: "ok", ...o,
});

let server: Server, base: string, service: TwinService, history: InMemoryHistory;
beforeEach(async () => {
  const registry = new client.Registry();
  const m = createMetrics(registry);
  history = new InMemoryHistory();
  service = new TwinService(new InMemoryTwinRepository(), {
    defaultFarmId: "f1", onApplied: () => m.applied.inc(), onDrop: (r) => m.dropped.inc({ reason: r }),
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
    expect(z.metrics.soilMoisture).toBe(26);
    expect(z.status).toBe("dry");
    expect((await fetch(`${base}/zones/nope`)).status).toBe(404);
    expect((await (await fetch(`${base}/zones`)).json()).length).toBe(1);
  });

  it("history lọc theo metric/thời gian và kiểm tra tham số", async () => {
    for (let i = 0; i < 5; i++) history.append(rd({ ts: new Date(now.getTime() + i * 60000).toISOString(), value: 30 - i }));
    const from = new Date(now.getTime() + 2 * 60000).toISOString();
    const h = await (await fetch(`${base}/zones/zone-A/history?metric=soil_moisture&from=${from}`)).json();
    expect(h.points.map((p: { value: number }) => p.value)).toEqual([28, 27, 26]);
    expect((await fetch(`${base}/zones/zone-A/history?metric=foo`)).status).toBe(400);
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
      ["a", "b", "c", "d"].map((id, i) => service.ingest(rd({ sensorId: id, value: 20 + i * 10 }), now)),
    );
    const z = (await service.getZone("zone-A"))!;
    expect(Object.keys(z.sensors).sort()).toEqual(["a", "b", "c", "d"]);
    expect(z.metrics.soilMoisture).toBe(35);
  });

  it("sweepStale đổi zone sang unknown và phát update", async () => {
    await service.ingest(rd({ value: 35 }), now);
    const events: string[] = [];
    service.on("update", (z) => events.push(z.status));
    const changed = await service.sweepStale(new Date(now.getTime() + 10 * 60000));
    expect(changed).toHaveLength(1);
    expect(events).toEqual(["unknown"]);
    expect((await service.sweepStale(new Date(now.getTime() + 11 * 60000)))).toHaveLength(0);
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
    await new Promise<void>((r) => s.close(() => r()));
  });
});
