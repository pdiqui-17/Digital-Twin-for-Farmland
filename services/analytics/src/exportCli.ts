import path from "node:path";
import dotenv from "dotenv";
import { Client } from "pg";
import { simTimeScale } from "@digital-twin/shared";
import { buildFieldSamples, openIntervalsFromCommands, type CommandRow, type RawReading } from "./domain/fieldSamples";

// Dùng: npm run export-samples -- --zone zone-B --from 2026-11-21T06:00:00Z [--to ISO] [--scale 300] > zone-B.csv
// Ghi CSV ts,moisture,temp,rain,open (giờ ruộng, bước 1 giờ) cho `npm run eval -- zone-B.csv 55,80`
// hoặc body của POST /model/calibrate. Chỉ nên lấy khoảng thời gian simulator bật hạn hán (rain = 0).
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
const env = process.env;

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const zone = arg("zone");
const from = arg("from");
const to = arg("to") ?? new Date().toISOString();
// Tỉ lệ phải là tỉ lệ LÚC dữ liệu được tạo; mặc định suy từ .env hiện tại.
const scale = Number(arg("scale") ?? simTimeScale(env));

function databaseUrl(): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const u = encodeURIComponent(env.POSTGRES_USER ?? "twin_user");
  const p = encodeURIComponent(env.POSTGRES_PASSWORD ?? "");
  return `postgres://${u}:${p}@${env.POSTGRES_HOST ?? "localhost"}:${env.POSTGRES_PORT ?? 5432}/${env.POSTGRES_DB ?? "digital_twin_farm"}`;
}

async function main() {
  if (!zone || !from || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || !(scale > 0)) {
    console.error("Cần --zone <id> --from <ISO> [--to <ISO>] [--scale <số giây ruộng / giây thật>]");
    process.exit(2);
  }
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    const readings = await db.query<{ ms: string; sensor_type: string; value: number }>(
      `SELECT (extract(epoch FROM ts) * 1000)::bigint AS ms, sensor_type, value
         FROM sensor_readings
        WHERE zone_id = $1 AND ts >= $2 AND ts < $3
          AND sensor_type IN ('soil_moisture', 'air_temperature')
          AND quality IN ('ok', 'noisy_smoothed')
        ORDER BY ts`,
      [zone, from, to],
    );
    const commands = await db.query<{ action: "open" | "close"; status: string; ms: string; ack_ms: string | null; duration_sec: number | null }>(
      `SELECT action, status, (extract(epoch FROM ts) * 1000)::bigint AS ms,
              (extract(epoch FROM acknowledged_at) * 1000)::bigint AS ack_ms, duration_sec
         FROM commands WHERE zone_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts`,
      [zone, from, to],
    );
    const raw: RawReading[] = readings.rows.map((r) => ({ tsMs: Number(r.ms), type: r.sensor_type, value: r.value }));
    const cmds: CommandRow[] = commands.rows.map((c) => ({
      action: c.action, status: c.status, tsMs: Number(c.ms), ackMs: c.ack_ms === null ? null : Number(c.ack_ms), durationSec: c.duration_sec,
    }));
    const samples = buildFieldSamples(raw, openIntervalsFromCommands(cmds), { timeScale: scale });

    console.log("ts,moisture,temp,rain,open");
    for (const s of samples)
      console.log(`${new Date(s.tsMs).toISOString()},${s.moisture.toFixed(3)},${s.temp.toFixed(2)},${s.rain},${s.open.toFixed(3)}`);
    const openHours = samples.reduce((a, s) => a + s.open, 0);
    console.error(`${zone}: ${raw.length} bản tin, ${cmds.length} lệnh -> ${samples.length} mẫu giờ ruộng (tỉ lệ ${scale}x), van mở tổng ${openHours.toFixed(1)} giờ ruộng`);
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
