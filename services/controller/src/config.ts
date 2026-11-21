import path from "node:path";
import dotenv from "dotenv";
import { simTimeScale } from "@digital-twin/shared";
import { DEFAULT_IRRIGATION, toRealSeconds, type IrrigationRules } from "./domain/valve";
import { DEFAULT_CONFIRM } from "./domain/alerts";

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

/** Số giây ruộng trong 1 giây thật (SIM_TIME_SCALE hoặc suy từ SIMULATOR_*; nông trại thật: 1). */
export const timeScale = simTimeScale(env);
/** Mốc tính bằng giây ruộng -> giây thật. */
const field = (v: string | undefined, d: number) => toRealSeconds(num(v, d), timeScale);

/**
 * CTRL_MAX_RUN_SEC, CTRL_MIN_REST_SEC: giây ruộng, tự chia theo tốc độ mô phỏng.
 * CTRL_ACK_TIMEOUT_SEC: giây thật (độ trễ mạng/thiết bị), không chia.
 */
export const irrigation: IrrigationRules = {
  stopFraction: num(env.CTRL_STOP_FRACTION, DEFAULT_IRRIGATION.stopFraction),
  maxRunSec: field(env.CTRL_MAX_RUN_SEC, DEFAULT_IRRIGATION.maxRunSec),
  minRestSec: field(env.CTRL_MIN_REST_SEC, DEFAULT_IRRIGATION.minRestSec),
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
  /** Giây thật. Mặc định khoảng 10 phút ruộng, trong khoảng 1-10 s (60 lần: 10 s; 300 lần: 2 s). */
  tickSec: num(env.CTRL_TICK_SEC ?? env.TICK_SEC, Math.min(10, toRealSeconds(600, timeScale))),
  /** Giây ruộng, tự chia theo tốc độ mô phỏng. */
  alertCooldownSec: field(env.CTRL_ALERT_COOLDOWN_SEC, 600),
  /** Giây thật: lỗi cảm biến / mất dữ liệu phải kéo dài chừng này mới mở cảnh báo (không chia theo tốc độ mô phỏng). */
  confirm: {
    sensorFaultSec: num(env.CTRL_FAULT_CONFIRM_SEC, DEFAULT_CONFIRM.sensorFaultSec),
    zoneUnknownSec: num(env.CTRL_UNKNOWN_CONFIRM_SEC, DEFAULT_CONFIRM.zoneUnknownSec),
  },
  autoIrrigation: env.AUTO_IRRIGATION !== "0",
  /** Luật tưới sớm theo dự đoán của analytics. Analytics tắt/lỗi/chưa calibrate thì tự quay về luật theo ngưỡng. */
  predict: env.CTRL_PREDICT !== "0",
  /** Tầm dự đoán, giờ ruộng (mô hình tin được ở 1-3 giờ). */
  predictHours: num(env.CTRL_PREDICT_HOURS, 1),
  analyticsUrl: env.ANALYTICS_URL ?? "http://localhost:3012",
};
