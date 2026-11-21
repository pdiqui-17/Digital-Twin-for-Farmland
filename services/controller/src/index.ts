import express from "express";
import client from "prom-client";
import { config, databaseUrl, irrigation } from "./config";
import { Controller } from "./controller";
import { defaultRules } from "./domain/alerts";
import { HttpTwinSource } from "./adapters/http";
import { LogCommandPublisher, MqttCommandPublisher } from "./adapters/mqtt";
import { ConsoleNotifier, TelegramNotifier } from "./adapters/notifier";
import { MemoryAlertStore, MemoryCommandStore } from "./adapters/memory";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, Notifier } from "./adapters/ports";

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const cmdCounter = new client.Counter({ name: "controller_commands_total", help: "Lệnh van đã gửi", labelNames: ["action"], registers: [registry] });
const alertCounter = new client.Counter({ name: "controller_alerts_total", help: "Sự kiện cảnh báo", labelNames: ["rule", "state"], registers: [registry] });
const tickErrors = new client.Counter({ name: "controller_tick_errors_total", help: "Tick lỗi", registers: [registry] });

async function main() {
  let commandStore: CommandStore = new MemoryCommandStore();
  let alertStore: AlertStore = new MemoryAlertStore();
  if (config.store === "pg") {
    const { Pool } = await import("pg");
    const { PgCommandStore, PgAlertStore } = await import("./adapters/pg");
    const pool = new Pool({ connectionString: databaseUrl() });
    commandStore = new PgCommandStore(pool);
    alertStore = new PgAlertStore(pool);
  }
  const rawPublisher: CommandPublisher = config.mqttUrl
    ? new MqttCommandPublisher(config.mqttUrl, config.mqttUsername, config.mqttPassword)
    : new LogCommandPublisher();
  const commandPublisher: CommandPublisher = { publish: async (c) => { await rawPublisher.publish(c); cmdCounter.inc({ action: c.action }); } };

  let alertPublisher: AlertPublisher = { publish: async () => {} };
  if (config.kafkaBrokers) {
    const { KafkaAlertPublisher } = await import("./adapters/kafka");
    alertPublisher = new KafkaAlertPublisher(config.kafkaBrokers.split(","));
  }
  const baseNotifier: Notifier = config.telegramToken && config.telegramChatId
    ? new TelegramNotifier(config.telegramToken, config.telegramChatId) : new ConsoleNotifier();
  const notifier: Notifier = { notify: async (e) => { alertCounter.inc({ rule: e.rule, state: e.state }); await baseNotifier.notify(e); } };

  const controller = new Controller({
    twin: new HttpTwinSource(config.twinUrl),
    commandPublisher, commandStore, alertStore, alertPublisher, notifier,
    irrigation, alertCooldownSec: config.alertCooldownSec, autoIrrigation: config.autoIrrigation,
    alertRules: defaultRules(config.confirm),
  });
  await controller.restore();

  let lastTickOk = false;
  let running = false;
  const tick = async () => {
    if (running) return; // tick trước chưa xong thì bỏ qua, tránh hai tick chồng nhau
    running = true;
    try { await controller.tick(); lastTickOk = true; }
    catch (e) { lastTickOk = false; tickErrors.inc(); console.error("tick error:", (e as Error).message); }
    finally { running = false; }
  };
  setInterval(() => void tick(), config.tickSec * 1000);
  void tick();

  const app = express();
  app.get("/healthz", (_q, r) => { r.json({ ok: true }); });
  app.get("/readyz", (_q, r) => { lastTickOk ? r.json({ ready: true }) : r.status(503).json({ ready: false }); });
  app.get("/metrics", async (_q, r) => { r.set("Content-Type", registry.contentType); r.send(await registry.metrics()); });
  app.listen(config.port, () => console.log(`controller listening on :${config.port} (store=${config.store}, twin=${config.twinUrl}, mqtt=${config.mqttUrl ?? "log"})`));
}
main().catch((e) => { console.error(e); process.exit(1); });
