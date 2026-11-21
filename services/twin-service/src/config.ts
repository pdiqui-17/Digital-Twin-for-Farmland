import path from "node:path";
import dotenv from "dotenv";

// Dùng chung file .env ở gốc repo với các service của Role A.
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const env = process.env;

/** DATABASE_URL nếu có, nếu không ghép từ POSTGRES_* (cùng quy ước với db/migrate.ts của Role A). */
export function databaseUrl(): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const u = encodeURIComponent(env.POSTGRES_USER ?? "twin_user");
  const p = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  return `postgres://${u}:${p}@${env.POSTGRES_HOST ?? "localhost"}:${env.POSTGRES_PORT ?? 5432}/${env.POSTGRES_DB ?? "digital_twin_farm"}`;
}

export const config = {
  port: Number(env.TWIN_PORT ?? env.PORT ?? 3010),
  farmId: env.FARM_ID ?? env.SIMULATOR_FARM_ID ?? "farm-01",
  /** memory | pg */
  store: env.TWIN_STORE ?? env.STORE ?? "memory",
  /** none | kafka */
  ingest: env.TWIN_INGEST ?? env.INGEST ?? "none",
  kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
  kafkaGroupId: env.TWIN_KAFKA_GROUP ?? "twin-service",
  mqttUrl: env.MQTT_URL ?? env.MQTT_BROKER_URL,
  mqttUsername: env.MQTT_USERNAME,
  mqttPassword: env.MQTT_PASSWORD,
  staleAfterSec: Number(env.TWIN_STALE_AFTER_SEC ?? 300),
  devIngest: env.ENABLE_DEV_INGEST === "1",
};
