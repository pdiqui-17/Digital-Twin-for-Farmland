/**
 * Đẩy dữ liệu giả vào Twin Service (cần chạy twin-service với ENABLE_DEV_INGEST=1).
 *   npx tsx scripts/fake-feed.ts [--url http://localhost:3001] [--zones 4] [--drought zone-B] [--interval 2]
 * Mỗi chu kỳ gửi soil_moisture/air_temp/air_humidity cho từng zone. Zone --drought khô nhanh hơn.
 */
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const url = arg("url", "http://localhost:3001");
const nZones = Number(arg("zones", "4"));
const drought = arg("drought", "");
const intervalSec = Number(arg("interval", "2"));
const zones = Array.from({ length: nZones }, (_, i) => `zone-${String.fromCharCode(65 + i)}`);
const moisture: Record<string, number> = Object.fromEntries(zones.map((z) => [z, 34]));

async function tick() {
  const ts = new Date().toISOString();
  const batch = zones.flatMap((z) => {
    moisture[z] = Math.max(8, moisture[z]! - (z === drought ? 0.6 : 0.05) + (Math.random() - 0.5) * 0.1);
    const mk = (type: string, value: number, unit: string, id: string) => ({ sensorId: `${id}-${z}`, zoneId: z, type, value, unit, ts, quality: "ok" });
    return [mk("soil_moisture", moisture[z]!, "percent", "sm"), mk("air_temp", 26 + Math.random(), "celsius", "at"), mk("air_humidity", 88 + Math.random() * 4, "percent", "ah")];
  });
  const res = await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
  console.log(new Date().toISOString(), res.status, zones.map((z) => `${z}=${moisture[z]!.toFixed(1)}`).join(" "));
}
setInterval(() => tick().catch((e) => console.error(e.message)), intervalSec * 1000);
void tick();
