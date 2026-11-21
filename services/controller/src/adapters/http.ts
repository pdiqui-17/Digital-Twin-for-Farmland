import type { ZoneState } from "@digital-twin/shared";
import type { Prediction } from "../domain/valve";
import type { ForecastSource, TwinSource } from "./ports";

export class HttpTwinSource implements TwinSource {
  constructor(private baseUrl: string, private fetchFn: typeof fetch = fetch) {}
  async zones(): Promise<ZoneState[]> {
    const res = await this.fetchFn(`${this.baseUrl}/zones`);
    if (!res.ok) throw new Error(`twin-service ${res.status}`);
    return (await res.json()) as ZoneState[];
  }
}

/**
 * POST /forecast của analytics. Gửi nhiệt độ hiện tại của twin (`temp`) để analytics không dùng dự báo
 * thời tiết ngoài, nên dự đoán khớp với nông trại đang chạy (kể cả simulator phát lại thời tiết cũ).
 * Lỗi mạng / timeout -> throw; hệ số chưa calibrate -> null.
 */
export class HttpForecastSource implements ForecastSource {
  constructor(private baseUrl: string, private timeoutMs = 1000, private fetchFn: typeof fetch = fetch) {}
  async predict(zone: ZoneState, hours: number): Promise<Prediction | null> {
    const res = await this.fetchFn(`${this.baseUrl}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        zoneId: zone.zoneId,
        moisture: zone.metrics.soilMoisture,
        temp: zone.metrics.airTemperature,
        horizonHours: hours,
        optimalMin: zone.thresholds.optimalLow,
        optimalMax: zone.thresholds.optimalHigh,
      }),
    });
    if (!res.ok) throw new Error(`analytics ${res.status}`);
    const j = (await res.json()) as { calibrated?: boolean; points?: { hour: number; moisture: number }[] };
    const last = j.points?.[j.points.length - 1];
    if (!j.calibrated || !last) return null;
    return { moisture: last.moisture, hours: last.hour };
  }
}
