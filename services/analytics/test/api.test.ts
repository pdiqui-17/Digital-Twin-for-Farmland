import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/app";
import { ConstantWeather, type WeatherProvider } from "../src/domain/weather";
import { generateSynthetic } from "../src/domain/synthetic";

let server: Server, base: string;
const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => { server = createApp({ weather: new ConstantWeather({ temp: 30, rain: 0 }) }).listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Analytics API", () => {
  it("POST /forecast trả quỹ đạo theo giờ", async () => {
    const res = await post("/forecast", { moisture: 30, horizonHours: 6 });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.points).toHaveLength(6);
    expect(j.points[5].moisture).toBeLessThan(30);
  });
  it("POST /whatif so sánh hai lịch tưới", async () => {
    const res = await post("/whatif", { moisture: 24, horizonHours: 12, schedules: [
      { name: "không tưới", windows: [] }, { name: "tưới 2h", windows: [{ startHour: 0, durationHours: 2 }] },
    ] });
    const j = await res.json();
    expect(j.scenarios).toHaveLength(2);
    expect(j.best).toBe("tưới 2h");
  });
  it("whatif dùng ngưỡng của zone khi truyền optimalMin/optimalMax", async () => {
    const body = (lo: number, hi: number) => ({ moisture: 50, horizonHours: 6, optimalMin: lo, optimalMax: hi, schedules: [{ name: "không tưới", windows: [] }] });
    const loose = await (await post("/whatif", body(30, 60))).json();
    const strict = await (await post("/whatif", body(55, 80))).json();
    expect(loose.scenarios[0].hoursBelowOptimal).toBe(0);
    expect(strict.scenarios[0].hoursBelowOptimal).toBe(6);
    expect((await post("/whatif", body(70, 40))).status).toBe(400);
  });
  it("/metrics đếm request", async () => {
    const text = await (await fetch(base + "/metrics")).text();
    expect(text).toContain("analytics_requests_total");
  });
  it("body sai trả 400", async () => {
    expect((await post("/forecast", { moisture: "x" })).status).toBe(400);
    expect((await post("/forecast", { moisture: 30, horizonHours: 999 })).status).toBe(400);
    expect((await post("/whatif", { moisture: 30, schedules: [] })).status).toBe(400);
    expect((await post("/whatif", { moisture: 30, schedules: [{ name: "a", windows: [{ startHour: "0" }] }] })).status).toBe(400);
  });
  it("POST /model/calibrate cập nhật GET /model", async () => {
    const before = await (await fetch(base + "/model")).json();
    const res = await post("/model/calibrate", { samples: generateSynthetic(400) });
    expect(res.status).toBe(200);
    const after = await (await fetch(base + "/model")).json();
    expect(after.fit).not.toBeNull();
    expect(after.params).not.toEqual(before.params);
    expect((await post("/model/calibrate", { samples: [] })).status).toBe(400);
  });
  it("nguồn thời tiết lỗi trả 502", async () => {
    const bad: WeatherProvider = { hourly: async () => { throw new Error("down"); } };
    const s = createApp({ weather: bad }).listen(0);
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const res = await fetch(b + "/forecast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moisture: 30 }) });
    expect(res.status).toBe(502);
    await new Promise<void>((r) => s.close(() => r()));
  });
});
