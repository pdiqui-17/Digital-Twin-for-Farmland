import { describe, it, expect } from "vitest";
import type { ZoneState } from "@digital-twin/shared";
import { DEFAULT_IRRIGATION as R, decide, initialValveCtx, needsPrediction, type ValveCtx } from "../src/domain/valve";
import { Controller } from "../src/controller";
import { HttpForecastSource } from "../src/adapters/http";
import { MemoryAlertStore, MemoryCommandStore } from "../src/adapters/memory";
import type { ForecastSource } from "../src/adapters/ports";
import { at, zone } from "./helpers";

// Ngưỡng khô của zone trong test là 45%.
describe("decide với dự đoán", () => {
  it("chưa khô nhưng dự đoán sẽ dưới ngưỡng thì mở sớm, lý do ghi rõ là dự đoán", () => {
    const d = decide(zone({ moisture: 46 }), initialValveCtx(), R, at(1), { moisture: 44.2, hours: 1 });
    expect(d.command).toMatchObject({ action: "open", durationSec: R.maxRunSec });
    expect(d.command!.reason).toBe("dự đoán 1h: 44.2% < 45% (hiện 46.0%)");
    expect(d.ctx.phase).toBe("pending");
  });
  it("dự đoán vẫn trên ngưỡng thì không mở", () => {
    expect(decide(zone({ moisture: 46 }), initialValveCtx(), R, at(1), { moisture: 45.3, hours: 1 }).command).toBeNull();
  });
  it("dự đoán không vượt qua các chốt an toàn: đang nghỉ, van đang mở", () => {
    const cooldown: ValveCtx = { phase: "cooldown", since: at(0).getTime() };
    expect(decide(zone({ moisture: 46 }), cooldown, R, at(1), { moisture: 40, hours: 1 }).command).toBeNull();
    expect(decide(zone({ moisture: 46, valve: "open" }), initialValveCtx(), R, at(1), { moisture: 40, hours: 1 }).command).toBeNull();
  });
  it("đã khô thì vẫn mở theo ngưỡng như cũ (lý do theo độ ẩm thật)", () => {
    expect(decide(zone({ moisture: 42 }), initialValveCtx(), R, at(1), { moisture: 41, hours: 1 }).command!.reason).toContain("42.0% < 45%");
  });
});

describe("needsPrediction: chỉ hỏi analytics khi dự đoán có thể đổi quyết định", () => {
  it("idle, van đóng, chưa khô, có nhiệt độ -> hỏi", () => expect(needsPrediction(zone({ moisture: 50 }), initialValveCtx())).toBe(true));
  it("không hỏi khi: đã khô, thiếu dữ liệu, thiếu nhiệt độ, van mở, không ở idle", () => {
    expect(needsPrediction(zone({ moisture: 42 }), initialValveCtx())).toBe(false);
    expect(needsPrediction(zone({ moisture: null }), initialValveCtx())).toBe(false);
    expect(needsPrediction(zone({ moisture: 50, temp: null }), initialValveCtx())).toBe(false);
    expect(needsPrediction(zone({ moisture: 50, valve: "open" }), initialValveCtx())).toBe(false);
    expect(needsPrediction(zone({ moisture: 50 }), { phase: "cooldown", since: 0 })).toBe(false);
  });
});

describe("Controller dùng dự đoán", () => {
  const build = (forecast: ForecastSource, z: ZoneState, results: string[] = []) => {
    const store = new MemoryCommandStore(), alerts = new MemoryAlertStore();
    const ctl = new Controller({
      twin: { zones: async () => [z] }, commandPublisher: store, commandStore: store,
      alertStore: alerts, alertPublisher: alerts, notifier: alerts,
      forecast, predictHours: 2, onPrediction: (r) => results.push(r),
    });
    return { ctl, store };
  };

  it("dự đoán dưới ngưỡng -> gửi lệnh mở, hỏi đúng tầm giờ cấu hình", async () => {
    const asked: number[] = [];
    const { ctl, store } = build({ predict: async (_z, h) => { asked.push(h); return { moisture: 44, hours: h }; } }, zone({ moisture: 47 }));
    await ctl.tick(at(1));
    expect(asked).toEqual([2]);
    expect(store.published).toHaveLength(1);
    expect((store.published[0] as { reason: string }).reason).toContain("dự đoán 2h");
  });
  it("analytics lỗi hoặc chưa calibrate -> không mở, tick không hỏng", async () => {
    const results: string[] = [];
    const a = build({ predict: async () => { throw new Error("down"); } }, zone({ moisture: 47 }), results);
    await a.ctl.tick(at(1));
    const b = build({ predict: async () => null }, zone({ moisture: 47 }), results);
    await b.ctl.tick(at(1));
    expect(a.store.published).toHaveLength(0);
    expect(b.store.published).toHaveLength(0);
    expect(results).toEqual(["error", "none"]);
  });
  it("analytics lỗi khi zone đã khô -> vẫn tưới theo ngưỡng", async () => {
    const { ctl, store } = build({ predict: async () => { throw new Error("down"); } }, zone({ moisture: 42 }));
    await ctl.tick(at(1));
    expect(store.published).toHaveLength(1);
  });
});

describe("HttpForecastSource", () => {
  const fake = (body: unknown, status = 200) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };
  it("gửi zoneId, độ ẩm, nhiệt độ của twin và ngưỡng; lấy điểm cuối của quỹ đạo", async () => {
    const f = fake({ calibrated: true, points: [{ hour: 1, moisture: 46 }, { hour: 2, moisture: 44.5 }] });
    const p = await new HttpForecastSource("http://a", 1000, f.fn).predict(zone({ moisture: 47, temp: 31 }), 2);
    expect(p).toEqual({ moisture: 44.5, hours: 2 });
    expect(f.calls[0]!.url).toBe("http://a/forecast");
    expect(f.calls[0]!.body).toEqual({ zoneId: "zone-A", moisture: 47, temp: 31, horizonHours: 2, optimalMin: 45, optimalMax: 70 });
  });
  it("chưa calibrate -> null; HTTP lỗi -> throw", async () => {
    expect(await new HttpForecastSource("http://a", 1000, fake({ calibrated: false, points: [{ hour: 1, moisture: 40 }] }).fn).predict(zone(), 1)).toBeNull();
    await expect(new HttpForecastSource("http://a", 1000, fake({}, 502).fn).predict(zone(), 1)).rejects.toThrow("analytics 502");
  });
});
