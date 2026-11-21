import client from "prom-client";
import { DEFAULT_THRESHOLDS } from "@digital-twin/shared";
import { config, databaseUrl } from "./config";
import { createApp, createMetrics } from "./app";
import { TwinService } from "./service";
import { InMemoryHistory, InMemoryTwinRepository } from "./repositories/memory";
import type { ZoneCatalog } from "./repositories/catalog";
import type { HistoryRepository, TwinRepository } from "./repositories/types";

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const m = createMetrics(registry);

async function main() {
  let repo: TwinRepository, history: HistoryRepository, catalog: ZoneCatalog | undefined;
  if (config.store === "pg") {
    const { Pool } = await import("pg");
    const { PgTwinRepository, PgHistory } = await import("./repositories/pg");
    const { loadPgZoneCatalog } = await import("./repositories/catalog");
    const pool = new Pool({ connectionString: databaseUrl() });
    repo = new PgTwinRepository(pool);
    history = new PgHistory(pool);
    catalog = await loadPgZoneCatalog(pool, config.staleAfterSec);
    console.log(`zone catalog: ${catalog.list().map((z) => `${z.zoneId}(${z.thresholds.optimalLow}-${z.thresholds.optimalHigh}%)`).join(", ")}`);
  } else {
    repo = new InMemoryTwinRepository();
    history = new InMemoryHistory();
  }
  const service = new TwinService(repo, {
    defaultFarmId: config.farmId,
    catalog,
    defaultThresholds: { ...DEFAULT_THRESHOLDS, staleAfterSec: config.staleAfterSec },
    timeScale: config.timeScale,
    onApplied: (r) => {
      m.applied.inc();
      m.ingestLag.set(Math.max(0, (Date.now() - Date.parse(r.ts)) / 1000));
    },
    onDrop: (reason) => m.dropped.inc({ reason }),
  });

  let ready = config.ingest !== "kafka";
  if (config.ingest === "kafka") {
    const { startKafkaIngest } = await import("./ingest");
    await startKafkaIngest(service, {
      brokers: config.kafkaBrokers, clientId: "twin-service", groupId: config.kafkaGroupId, onInvalid: () => m.invalid.inc(),
    });
    ready = true;
  }
  setInterval(() => service.sweepStale().catch((e) => console.error("sweep failed:", (e as Error).message)), 30_000);
  if (config.mqttUrl) {
    const { startMqttValveState } = await import("./mqttState");
    startMqttValveState(service, { url: config.mqttUrl, farmId: config.farmId, username: config.mqttUsername, password: config.mqttPassword });
  }
  const app = createApp({ service, history, registry, ready: () => ready, devIngest: config.devIngest });
  app.listen(config.port, () => console.log(`twin-service listening on :${config.port} (store=${config.store}, ingest=${config.ingest}, timeScale=${config.timeScale}x)`));
}
main().catch((e) => { console.error(e); process.exit(1); });
