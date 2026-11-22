import express from "express";
import client from "prom-client";
import { DEFAULT_THRESHOLDS, deriveThresholds, type Thresholds } from "@digital-twin/shared";
import { calibrate, type CalibrationResult, type Sample } from "./domain/calibrate";
import { parseCsv } from "./domain/dataset";
import { forecast, type IrrigationWindow } from "./domain/forecast";
import { whatIf, type Schedule } from "./domain/whatif";
import { DEFAULT_PARAMS } from "./domain/waterBalance";
import type { WeatherProvider } from "./domain/weather";

/** Tọa độ farm-01 trong seed của Role A (Lâm Đồng). */
export const FARM_LAT = 11.9404;
export const FARM_LON = 108.4583;

export interface ZoneModel { params: typeof DEFAULT_PARAMS; fit: CalibrationResult; }
/** params/fit: hệ số chung (request không có zoneId). zones: hệ số đã fit riêng theo zone. */
export interface ModelState { params: typeof DEFAULT_PARAMS; fit: CalibrationResult | null; zones: Record<string, ZoneModel>; }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const parseWindows = (w: unknown): IrrigationWindow[] | null => {
  if (!Array.isArray(w)) return null;
  const out: IrrigationWindow[] = [];
  for (const x of w) {
    if (!x || !isNum(x.startHour) || !isNum(x.durationHours) || x.durationHours < 0) return null;
    out.push({ startHour: x.startHour, durationHours: x.durationHours });
  }
  return out;
};

/**
 * Ngưỡng của zone cho request: body.optimalMin/optimalMax (lấy từ twin.thresholds hoặc bảng zones),
 * thiếu thì dùng mặc định. undefined = tham số sai.
 */
function thresholdsFor(body: { optimalMin?: unknown; optimalMax?: unknown } | undefined, fallback: Thresholds): Thresholds | undefined {
  const lo = body?.optimalMin, hi = body?.optimalMax;
  if (lo === undefined && hi === undefined) return fallback;
  if (!isNum(lo) || !isNum(hi) || lo < 0 || hi > 100 || lo >= hi) return undefined;
  return deriveThresholds(lo, hi, fallback.staleAfterSec);
}

export function createApp(deps: {
  weather: WeatherProvider; model?: ModelState; thresholds?: Thresholds; defaultLat?: number; defaultLon?: number; registry?: client.Registry;
  /** Gọi sau mỗi lần calibrate thành công (vd. ghi file) để hệ số không mất khi khởi động lại. */
  persist?: (m: ModelState) => void;
}) {
  const defaults = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const model: ModelState = deps.model ?? { params: DEFAULT_PARAMS, fit: null, zones: {} };
  /** Hệ số cho request: của zone nếu đã fit, không thì hệ số chung. calibrated = hệ số đó đến từ dữ liệu thật. */
  const paramsFor = (zoneId: unknown) => {
    const z = typeof zoneId === "string" ? model.zones[zoneId] : undefined;
    if (z) return { params: z.params, calibrated: true };
    return { params: model.params, calibrated: model.fit !== null && zoneId === undefined };
  };
  const registry = deps.registry ?? new client.Registry();
  const requests = new client.Counter({ name: "analytics_requests_total", help: "Request theo endpoint và kết quả", labelNames: ["endpoint", "status"], registers: [registry] });
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => { res.on("finish", () => requests.inc({ endpoint: req.path, status: String(res.statusCode) })); next(); });

  app.get("/healthz", (_q, r) => { r.json({ ok: true }); });
  app.get("/readyz", (_q, r) => { r.json({ ready: true }); });
  app.get("/metrics", async (_q, r) => { r.set("Content-Type", registry.contentType); r.send(await registry.metrics()); });
  app.get("/model", (_q, r) => { r.json(model); });

  app.post("/model/calibrate", (req, res) => {
    // samples (JSON) hoặc csv (đúng định dạng `npm run export-samples` in ra)
    const rows = typeof req.body?.csv === "string" ? parseCsv(req.body.csv) : req.body?.samples as Sample[] | undefined;
    const th = thresholdsFor(req.body, defaults);
    if (!Array.isArray(rows) || rows.length < 10 || !th) return void res.status(400).json({ error: "need_samples" });
    const fit = calibrate(rows, th.fieldCapacity);
    if (!Number.isFinite(fit.rmseDelta)) return void res.status(422).json({ error: "calibration_failed" });
    const zoneId = req.body?.zoneId;
    if (zoneId !== undefined && (typeof zoneId !== "string" || !zoneId)) return void res.status(400).json({ error: "invalid_zone" });
    if (zoneId) model.zones[zoneId] = { params: fit.params, fit };
    else { model.params = fit.params; model.fit = fit; }
    deps.persist?.(model);
    res.json(model);
  });

  /**
   * Thời tiết cho dự đoán. Có body.temp: coi nhiệt độ không đổi và không mưa (người gọi là controller,
   * đưa nhiệt độ hiện tại của twin, nên dự đoán khớp với nông trại đang chạy, kể cả simulator). Không có: hỏi provider.
   */
  const weatherFor = async (b: { lat?: number; lon?: number; temp?: unknown }, hours: number) =>
    isNum(b.temp)
      ? Array.from({ length: hours }, () => ({ temp: b.temp as number, rain: 0 }))
      : deps.weather.hourly(b.lat ?? deps.defaultLat ?? FARM_LAT, b.lon ?? deps.defaultLon ?? FARM_LON, hours);

  app.post("/forecast", async (req, res) => {
    const { moisture, horizonHours = 6, irrigation = [], temp } = req.body ?? {};
    const win = parseWindows(irrigation);
    const th = thresholdsFor(req.body, defaults);
    if (!isNum(moisture) || !isNum(horizonHours) || horizonHours < 1 || horizonHours > 48 || !win || !th || (temp !== undefined && !isNum(temp)))
      return void res.status(400).json({ error: "invalid_body" });
    const { params, calibrated } = paramsFor(req.body.zoneId);
    try {
      const w = await weatherFor(req.body, horizonHours);
      res.json({ calibrated, points: forecast(moisture, params, w, win, horizonHours, th.fieldCapacity) });
    } catch { res.status(502).json({ error: "weather_unavailable" }); }
  });

  app.post("/whatif", async (req, res) => {
    const { moisture, horizonHours = 24, schedules } = req.body ?? {};
    const okSched = Array.isArray(schedules) && schedules.length >= 1 && schedules.length <= 10 &&
      schedules.every((s: Schedule) => typeof s?.name === "string" && parseWindows(s.windows));
    const th = thresholdsFor(req.body, defaults);
    if (!isNum(moisture) || !isNum(horizonHours) || horizonHours < 1 || horizonHours > 72 || !okSched || !th)
      return void res.status(400).json({ error: "invalid_body" });
    try {
      const w = await weatherFor(req.body, horizonHours);
      res.json(whatIf(moisture, paramsFor(req.body.zoneId).params, w, schedules, horizonHours, th));
    } catch { res.status(502).json({ error: "weather_unavailable" }); }
  });
  return app;
}
