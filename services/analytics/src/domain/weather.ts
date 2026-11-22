export interface HourlyWeather { temp: number; rain: number; }

export interface WeatherProvider {
  /** Dự báo theo giờ, bắt đầu từ giờ hiện tại, tối thiểu `hours` phần tử (nếu nguồn có). */
  hourly(lat: number, lon: number, hours: number): Promise<HourlyWeather[]>;
}

/** Open-Meteo: miễn phí, không cần key. Có cache theo toạ độ để không gọi lặp. */
export class OpenMeteoProvider implements WeatherProvider {
  private cache = new Map<string, { at: number; data: HourlyWeather[] }>();
  constructor(private fetchFn: typeof fetch = fetch, private ttlMs = 30 * 60_000, private clock = () => Date.now()) {}

  async hourly(lat: number, lon: number, hours: number): Promise<HourlyWeather[]> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs && hit.data.length >= hours) return hit.data.slice(0, hours);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation&forecast_days=3&timezone=UTC`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as { hourly?: { time: string[]; temperature_2m: (number | null)[]; precipitation: (number | null)[] } };
    const h = j.hourly;
    if (!h) throw new Error("open-meteo: thiếu hourly");
    const nowMs = this.clock();
    const data: HourlyWeather[] = [];
    h.time.forEach((t, i) => {
      if (Date.parse(t + "Z") + 3_600_000 <= nowMs) return; // bỏ giờ đã qua
      data.push({ temp: h.temperature_2m[i] ?? 25, rain: h.precipitation[i] ?? 0 });
    });
    this.cache.set(key, { at: nowMs, data });
    return data.slice(0, hours);
  }
}

/** Dùng khi không có dự báo: giả định không mưa, nhiệt độ cố định. */
export class ConstantWeather implements WeatherProvider {
  constructor(private w: HourlyWeather = { temp: 25, rain: 0 }) {}
  async hourly(_la: number, _lo: number, hours: number) { return Array.from({ length: hours }, () => this.w); }
}
