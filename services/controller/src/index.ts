import express from "express";
import client from "prom-client";
import { Controller } from "./controller";
import { HttpTwinSource } from "./adapters/http";
import { LogCommandPublisher, MqttCommandPublisher } from "./adapters/mqtt";
import { ConsoleNotifier, TelegramNotifier } from "./adapters/notifier";
import { MemoryAlertStore, MemoryCommandStore } from "./adapters/memory";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, Notifier } from "./adapters/ports";

const env = process.env;
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const cmdCounter = new client.Counter({ name: "controller_commands_total", help: "Lệnh van đã gửi", labelNames: ["action"], registers: [registry] });
const alertCounter = new client.Counter({ name: "controller_alerts_total", help: "Sự kiện cảnh báo", labelNames: ["rule", "state"], registers: [registry] });
const tickErrors = new client.Counter({ name: "controller_tick_errors_total", help: "Tick lỗi", registers: [registry] });

async function main() {
  const farmId = env.FARM_ID ?? "farm-1";
  let commandStore: CommandStore = new MemoryCommandStore();
  let alertStore: AlertStore = new MemoryAlertStore();
  if (env.STORE === "pg") {
    const { Pool } = await import("pg");
    const { PgCommandStore, PgAlertStore } = await import("./adapters/pg");
    const pool = new Pool({ connectionString: env.DATABASE_URL });
    commandStore = new PgCommandStore(pool);
    alertStore = new PgAlertStore(pool);
  }
  const rawPublisher: CommandPublisher = env.MQTT_URL
    ? new MqttCommandPublisher(env.MQTT_URL, farmId, env.MQTT_USERNAME, env.MQTT_PASSWORD)
    : new LogCommandPublisher();
  const commandPublisher: CommandPublisher = { publish: async (c) => { await rawPublisher.publish(c); cmdCounter.inc({ action: c.action }); } };

  let alertPublisher: AlertPublisher = { publish: async () => {} };
  if (env.KAFKA_BROKERS) {
    const { KafkaAlertPublisher } = await import("./adapters/kafka");
    alertPublisher = new KafkaAlertPublisher(env.KAFKA_BROKERS.split(","));
  }
  const baseNotifier: Notifier = env.TELEGRAM_TOKEN && env.TELEGRAM_CHAT_ID
    ? new TelegramNotifier(env.TELEGRAM_TOKEN, env.TELEGRAM_CHAT_ID) : new ConsoleNotifier();
  const notifier: Notifier = { notify: async (e) => { alertCounter.inc({ rule: e.rule, state: e.state }); await baseNotifier.notify(e); } };

  const controller = new Controller({
    twin: new HttpTwinSource(env.TWIN_URL ?? "http://localhost:3001"),
    commandPublisher, commandStore, alertStore, alertPublisher, notifier,
    autoIrrigation: env.AUTO_IRRIGATION !== "0",
  });

  let lastTickOk = false;
  const tick = () => controller.tick().then(() => { lastTickOk = true; }, (e) => { lastTickOk = false; tickErrors.inc(); console.error("tick error:", e.message); });
  setInterval(tick, Number(env.TICK_SEC ?? 10) * 1000);
  void tick();

  const app = express();
  app.get("/healthz", (_q, r) => { r.json({ ok: true }); });
  app.get("/readyz", (_q, r) => { lastTickOk ? r.json({ ready: true }) : r.status(503).json({ ready: false }); });
  app.get("/metrics", async (_q, r) => { r.set("Content-Type", registry.contentType); r.send(await registry.metrics()); });
  app.listen(Number(env.PORT ?? 3002), () => console.log("controller listening"));
}
main().catch((e) => { console.error(e); process.exit(1); });
