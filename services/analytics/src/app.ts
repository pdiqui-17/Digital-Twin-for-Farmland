import express from "express";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@farm/shared";
import { calibrate, type CalibrationResult, type Sample } from "./domain/calibrate";
import { forecast, type IrrigationWindow } from "./domain/forecast";
import { whatIf, type Schedule } from "./domain/whatif";
import { DEFAULT_PARAMS } from "./domain/waterBalance";
import type { WeatherProvider } from "./domain/weather";

export interface ModelState { params: typeof DEFAULT_PARAMS; fit: CalibrationResult | null; }

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

export function createApp(deps: { weather: WeatherProvider; model?: ModelState; thresholds?: Thresholds; defaultLat?: number; defaultLon?: number }) {
  const th = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const model: ModelState = deps.model ?? { params: DEFAULT_PARAMS, fit: null };
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/healthz", (_q, r) => { r.json({ ok: true }); });
  app.get("/readyz", (_q, r) => { r.json({ ready: true }); });
  app.get("/model", (_q, r) => { r.json(model); });

  app.post("/model/calibrate", (req, res) => {
    const rows = req.body?.samples as Sample[] | undefined;
    if (!Array.isArray(rows) || rows.length < 10) return void res.status(400).json({ error: "need_samples" });
    const fit = calibrate(rows, th.fieldCapacity);
    if (!Number.isFinite(fit.rmseDelta)) return void res.status(422).json({ error: "calibration_failed" });
    model.params = fit.params; model.fit = fit;
    res.json(model);
  });

  const weatherFor = async (b: { lat?: number; lon?: number }, hours: number) =>
    deps.weather.hourly(b.lat ?? deps.defaultLat ?? 21.03, b.lon ?? deps.defaultLon ?? 105.85, hours);

  app.post("/forecast", async (req, res) => {
    const { moisture, horizonHours = 6, irrigation = [] } = req.body ?? {};
    const win = parseWindows(irrigation);
    if (!isNum(moisture) || !isNum(horizonHours) || horizonHours < 1 || horizonHours > 48 || !win)
      return void res.status(400).json({ error: "invalid_body" });
    try {
      const w = await weatherFor(req.body, horizonHours);
      res.json({ points: forecast(moisture, model.params, w, win, horizonHours, th.fieldCapacity) });
    } catch { res.status(502).json({ error: "weather_unavailable" }); }
  });

  app.post("/whatif", async (req, res) => {
    const { moisture, horizonHours = 24, schedules } = req.body ?? {};
    const okSched = Array.isArray(schedules) && schedules.length >= 1 && schedules.length <= 10 &&
      schedules.every((s: Schedule) => typeof s?.name === "string" && parseWindows(s.windows));
    if (!isNum(moisture) || !isNum(horizonHours) || horizonHours < 1 || horizonHours > 72 || !okSched)
      return void res.status(400).json({ error: "invalid_body" });
    try {
      const w = await weatherFor(req.body, horizonHours);
      res.json(whatIf(moisture, model.params, w, schedules, horizonHours, th));
    } catch { res.status(502).json({ error: "weather_unavailable" }); }
  });
  return app;
}
