/**
 * Đẩy dữ liệu giả vào Twin Service khi không chạy simulator/processor của Role A
 * (cần twin-service với ENABLE_DEV_INGEST=1).
 *   npx tsx scripts/fake-feed.ts [--url http://localhost:3010] [--zones 4] [--drought zone-B] [--interval 2] [--fault s-A-moisture]
 * Message theo CleanTelemetryMessageSchema (telemetry.clean). Zone --drought khô nhanh hơn.
 * --fault gắn cờ out_of_range cho một sensor để thử cảnh báo sensor_fault.
 */
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const url = arg("url", "http://localhost:3010");
const nZones = Number(arg("zones", "4"));
const drought = arg("drought", "");
const fault = arg("fault", "");
const intervalSec = Number(arg("interval", "2"));
const farmId = "farm-01";
const zones = Array.from({ length: nZones }, (_, i) => String.fromCharCode(65 + i));
const moisture: Record<string, number> = Object.fromEntries(zones.map((z) => [z, 60]));

async function tick() {
  const ts = new Date().toISOString();
  const batch = zones.flatMap((z) => {
    moisture[z] = Math.max(10, moisture[z]! - (`zone-${z}` === drought ? 0.6 : 0.05) + (Math.random() - 0.5) * 0.1);
    const mk = (kind: string, type: string, value: number, unit: string) => {
      const sensorId = `s-${z}-${kind}`;
      return {
        farmId, zoneId: `zone-${z}`, sensorId, type, value, unit, ts, ingestedAt: ts,
        quality: sensorId === fault ? "out_of_range" : "ok",
      };
    };
    return [
      mk("moisture", "soil_moisture", moisture[z]!, "percent"),
      mk("temp", "air_temperature", 22 + Math.random(), "celsius"),
      mk("humidity", "air_humidity", 88 + Math.random() * 4, "percent"),
    ];
  });
  const res = await fetch(`${url}/ingest`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch) });
  console.log(new Date().toISOString(), res.status, zones.map((z) => `zone-${z}=${moisture[z]!.toFixed(1)}`).join(" "));
}
setInterval(() => tick().catch((e) => console.error(e.message)), intervalSec * 1000);
void tick();
