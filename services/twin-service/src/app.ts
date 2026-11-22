import express from "express";
import client from "prom-client";
import { CleanTelemetryMessageSchema, SensorTypeSchema, type ZoneState } from "@digital-twin/shared";
import type { TwinService } from "./service";
import type { HistoryRepository } from "./repositories/types";

export interface AppDeps {
  service: TwinService;
  history: HistoryRepository;
  registry?: client.Registry;
  ready?: () => boolean;
  /** Bật POST /ingest cho môi trường dev/fake-feed (mặc định tắt). */
  devIngest?: boolean;
}

/** Reading cho POST /ingest: như telemetry.clean nhưng farmId/ingestedAt không bắt buộc. */
const DevReadingSchema = CleanTelemetryMessageSchema.partial({ farmId: true, ingestedAt: true });

export function createMetrics(registry: client.Registry) {
  return {
    applied: new client.Counter({ name: "twin_readings_applied_total", help: "Readings áp vào twin", registers: [registry] }),
    dropped: new client.Counter({ name: "twin_readings_dropped_total", help: "Readings không áp vào chỉ số", labelNames: ["reason"], registers: [registry] }),
    invalid: new client.Counter({ name: "twin_messages_invalid_total", help: "Message Kafka sai schema/JSON", registers: [registry] }),
    ingestLag: new client.Gauge({ name: "twin_ingest_lag_seconds", help: "Độ trễ giữa ts reading và lúc xử lý", registers: [registry] }),
  };
}

const STATUSES = ["ok", "dry", "critical", "unknown"] as const;

export function createApp({ service, history, registry = new client.Registry(), ready = () => true, devIngest = false }: AppDeps) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const gauge = new client.Gauge({ name: "twin_zone_status", help: "1 nếu zone đang ở status này", labelNames: ["zone", "status"], registers: [registry] });
  const setStatus = (z: ZoneState) => STATUSES.forEach((s) => gauge.set({ zone: z.zoneId, status: s }, z.status === s ? 1 : 0));
  service.on("update", setStatus);

  app.get("/healthz", (_req, res) => { res.json({ ok: true }); });
  app.get("/readyz", (_req, res) => { ready() ? res.json({ ready: true }) : res.status(503).json({ ready: false }); });
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  if (devIngest) {
    app.post("/ingest", async (req, res) => {
      const items = Array.isArray(req.body) ? req.body : [req.body];
      const parsed = items.map((x) => DevReadingSchema.safeParse(x));
      if (parsed.some((p) => !p.success)) return void res.status(400).json({ error: "invalid_reading" });
      const results = [];
      for (const p of parsed) if (p.success) results.push(await service.ingest(p.data));
      res.json({ results });
    });
  }

  app.get("/zones", async (_req, res) => { res.json(await service.listZones()); });

  app.get("/zones/:id", async (req, res) => {
    const z = await service.getZone(req.params.id);
    if (!z) return void res.status(404).json({ error: "zone_not_found" });
    res.json(z);
  });

  app.get("/zones/:id/history", async (req, res) => {
    const type = SensorTypeSchema.safeParse(req.query.metric ?? "soil_moisture");
    if (!type.success) return void res.status(400).json({ error: "invalid_metric" });
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit ?? 500) || 500));
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to))))
      return void res.status(400).json({ error: "invalid_time" });
    const points = await history.query({ zoneId: req.params.id, type: type.data, from, to, limit });
    res.json({ zoneId: req.params.id, metric: type.data, points });
  });

  // SSE: đẩy cập nhật zone theo thời gian thực. ?zone=<id> để lọc.
  app.get("/stream", (req, res) => {
    const only = typeof req.query.zone === "string" ? req.query.zone : null;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const onUpdate = (z: ZoneState) => {
      if (only && z.zoneId !== only) return;
      res.write(`event: zone\ndata: ${JSON.stringify(z)}\n\n`);
    };
    service.on("update", onUpdate);
    const hb = setInterval(() => res.write(": hb\n\n"), 15000);
    req.on("close", () => { clearInterval(hb); service.off("update", onUpdate); });
  });

  return app;
}
