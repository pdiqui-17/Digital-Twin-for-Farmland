import client from "prom-client";
import { createApp, createMetrics } from "./app";
import { TwinService } from "./service";
import { InMemoryHistory, InMemoryTwinRepository } from "./repositories/memory";

const port = Number(process.env.PORT ?? 3001);
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const m = createMetrics(registry);

async function main() {
  let repo, history;
  if (process.env.STORE === "pg") {
    const { Pool } = await import("pg");
    const { PgTwinRepository, PgHistory } = await import("./repositories/pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    repo = new PgTwinRepository(pool);
    history = new PgHistory(pool);
  } else {
    repo = new InMemoryTwinRepository();
    history = new InMemoryHistory();
  }
  const service = new TwinService(repo, {
    defaultFarmId: process.env.FARM_ID ?? "farm-1",
    onApplied: (r) => {
      m.applied.inc();
      m.ingestLag.set(Math.max(0, (Date.now() - Date.parse(r.ts)) / 1000));
    },
    onDrop: (reason) => m.dropped.inc({ reason }),
  });
  let ready = process.env.INGEST !== "kafka";
  if (process.env.INGEST === "kafka") {
    const { startKafkaIngest } = await import("./ingest");
    await startKafkaIngest(service, (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","));
    ready = true;
  }
  setInterval(() => service.sweepStale().catch(() => undefined), 30_000);
  if (process.env.MQTT_URL) {
    const { startMqttValveState } = await import("./mqttState");
    startMqttValveState(service, process.env.MQTT_URL, process.env.MQTT_USERNAME, process.env.MQTT_PASSWORD);
  }
  const app = createApp({ service, history, registry, ready: () => ready, devIngest: process.env.ENABLE_DEV_INGEST === "1" });
  app.listen(port, () => console.log(`twin-service listening on :${port}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
