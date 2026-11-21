import path from "node:path";
import dotenv from "dotenv";
import { DEFAULT_IRRIGATION, type IrrigationRules } from "./domain/valve";

// Dùng chung file .env ở gốc repo với các service của Role A.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

/** DATABASE_URL nếu có, nếu không ghép từ POSTGRES_* (cùng quy ước với db/migrate.ts của Role A). */
export function databaseUrl(): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const u = encodeURIComponent(env.POSTGRES_USER ?? "twin_user");
  const p = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  return `postgres://${u}:${p}@${env.POSTGRES_HOST ?? "localhost"}:${env.POSTGRES_PORT ?? 5432}/${env.POSTGRES_DB ?? "digital_twin_farm"}`;
}

/** Mốc thời gian chỉnh được: khi simulator chạy nhanh (SIMULATOR_PHYSICS_MINUTES_PER_TICK) có thể rút ngắn. */
export const irrigation: IrrigationRules = {
  stopFraction: num(env.CTRL_STOP_FRACTION, DEFAULT_IRRIGATION.stopFraction),
  maxRunSec: num(env.CTRL_MAX_RUN_SEC, DEFAULT_IRRIGATION.maxRunSec),
  minRestSec: num(env.CTRL_MIN_REST_SEC, DEFAULT_IRRIGATION.minRestSec),
  ackTimeoutSec: num(env.CTRL_ACK_TIMEOUT_SEC, DEFAULT_IRRIGATION.ackTimeoutSec),
};

export const config = {
  port: num(env.CONTROLLER_PORT ?? env.PORT, 3011),
  twinUrl: env.TWIN_URL ?? "http://localhost:3010",
  /** memory | pg */
  store: env.CONTROLLER_STORE ?? env.STORE ?? "memory",
  mqttUrl: env.MQTT_URL ?? env.MQTT_BROKER_URL,
  mqttUsername: env.MQTT_USERNAME,
  mqttPassword: env.MQTT_PASSWORD,
  kafkaBrokers: env.KAFKA_BROKERS,
  telegramToken: env.TELEGRAM_TOKEN,
  telegramChatId: env.TELEGRAM_CHAT_ID,
  tickSec: num(env.CTRL_TICK_SEC ?? env.TICK_SEC, 10),
  alertCooldownSec: num(env.CTRL_ALERT_COOLDOWN_SEC, 600),
  autoIrrigation: env.AUTO_IRRIGATION !== "0",
};
