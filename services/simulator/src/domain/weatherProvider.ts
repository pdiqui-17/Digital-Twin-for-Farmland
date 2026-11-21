import { Logger } from '@digital-twin/shared';

export interface AmbientWeather {
  temperatureCelsius: number;
  humidityPercent: number;
  lightLux: number;
  precipitationMmPerHour: number;
  source: 'open-meteo' | 'synthetic-fallback';
}

interface HourlyWeatherSample {
  temperatureCelsius: number;
  humidityPercent: number;
  lightLux: number;
  precipitationMmPerHour: number;
}

interface OpenMeteoArchiveResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: Array<number | null>;
    relative_humidity_2m?: Array<number | null>;
    precipitation?: Array<number | null>;
    shortwave_radiation?: Array<number | null>;
  };
}

/**
 * Cung cấp thời tiết môi trường ngoài từ dữ liệu lịch sử Open-Meteo (miễn phí, không cần API key).
 * Tự động chuyển về mô hình chu kỳ ngày/đêm nội bộ nếu tắt mạng hoặc API không phản hồi.
 */
export class WeatherProvider {
  private cachedSamples: HourlyWeatherSample[] = [];
  private lastFetchMs = 0;
  private readonly refreshIntervalMs = 6 * 60 * 60 * 1000; // 6 giờ

  constructor(
    private readonly latitude: number,
    private readonly longitude: number,
    private readonly enabled: boolean,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    if (!this.enabled) {
      this.logger.info('Open-Meteo weather integration disabled via config; using synthetic diurnal curve');
      return;
    }
    await this.refreshHistoricalCache();
  }

  /**
   * Trả về thông số thời tiết tại một thời điểm (nội suy mượt theo phút trong giờ).
   */
  getWeatherAt(virtualClockDate: Date, droughtMode: boolean): AmbientWeather {
    // Làm mới cache nền nếu đã quá hạn (không chặn vòng lặp chính)
    if (this.enabled && Date.now() - this.lastFetchMs > this.refreshIntervalMs) {
      void this.refreshHistoricalCache();
    }

    let base: AmbientWeather;
    if (this.cachedSamples.length >= 24) {
      base = this.interpolateFromCache(virtualClockDate);
    } else {
      base = this.computeSyntheticDiurnalWeather(virtualClockDate);
    }

    if (!droughtMode) {
      return base;
    }

    // Kịch bản hạn hán: nắng gắt hơn, không mưa, không khí khô làm tăng bốc thoát hơi nước
    return {
      temperatureCelsius: Math.min(48, base.temperatureCelsius + 6.5),
      humidityPercent: Math.max(18, base.humidityPercent - 25),
      lightLux: Math.min(130000, Math.max(base.lightLux * 1.25, this.isDaytime(virtualClockDate) ? 65000 : 0)),
      precipitationMmPerHour: 0,
      source: base.source,
    };
  }

  private interpolateFromCache(date: Date): AmbientWeather {
    const totalHours = Math.floor(date.getTime() / 3_600_000);
    const minuteFraction = (date.getUTCMinutes() * 60 + date.getUTCSeconds()) / 3600;

    const idx0 = ((totalHours % this.cachedSamples.length) + this.cachedSamples.length) % this.cachedSamples.length;
    const idx1 = (idx0 + 1) % this.cachedSamples.length;

    const s0 = this.cachedSamples[idx0];
    const s1 = this.cachedSamples[idx1];
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

    return {
      temperatureCelsius: lerp(s0.temperatureCelsius, s1.temperatureCelsius, minuteFraction),
      humidityPercent: lerp(s0.humidityPercent, s1.humidityPercent, minuteFraction),
      lightLux: Math.max(0, lerp(s0.lightLux, s1.lightLux, minuteFraction)),
      precipitationMmPerHour: Math.max(0, lerp(s0.precipitationMmPerHour, s1.precipitationMmPerHour, minuteFraction)),
      source: 'open-meteo',
    };
  }

  /**
   * Chu kỳ ngày/đêm vùng cao nguyên (Đà Lạt / Lâm Đồng) theo giờ địa phương (UTC+7).
   */
  private computeSyntheticDiurnalWeather(date: Date): AmbientWeather {
    const localHour = ((date.getUTCHours() + 7) % 24) + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;

    // Nhiệt độ cực tiểu ~05:00 (15.5°C), cực đại ~14:00 (26.5°C)
    const tempWave = Math.sin(((localHour - 8.5) / 24) * 2 * Math.PI);
    const temperatureCelsius = 21.0 + 5.5 * tempWave;

    // Độ ẩm không khí ngược pha với nhiệt độ (52% trưa -> 90% đêm)
    const humidityPercent = Math.min(96, Math.max(40, 71.0 - 19.0 * tempWave));

    // Ánh sáng mặt trời: bình minh 06:00, đỉnh 12:00 (~85,000 lux), hoàng hôn 18:00
    let lightLux = 0;
    if (localHour >= 6 && localHour <= 18) {
      const sunAngle = ((localHour - 6) / 12) * Math.PI;
      lightLux = 85000 * Math.pow(Math.sin(sunAngle), 1.4);
    }

    // Mưa rào nhẹ chiều tối đặc trưng (15:30 - 16:30 một số chu kỳ ngày)
    const dayIndex = Math.floor(date.getTime() / 86_400_000);
    const hasAfternoonShower = dayIndex % 3 === 1 && localHour >= 15.5 && localHour <= 16.25;
    const precipitationMmPerHour = hasAfternoonShower ? 2.4 : 0;

    return {
      temperatureCelsius,
      humidityPercent,
      lightLux,
      precipitationMmPerHour,
      source: 'synthetic-fallback',
    };
  }

  private isDaytime(date: Date): boolean {
    const localHour = (date.getUTCHours() + 7) % 24;
    return localHour >= 6 && localHour <= 18;
  }

  private async refreshHistoricalCache(): Promise<void> {
    this.lastFetchMs = Date.now();

    // Lấy cửa sổ 7 ngày cách hiện tại 14->7 ngày để kho Archive Open-Meteo luôn chốt đủ dữ liệu
    // Dùng năm cố định an toàn (2024) nếu đồng hồ hệ thống ở tương lai xa
    const referenceEnd = new Date(Math.min(Date.now() - 7 * 86_400_000, Date.UTC(2025, 4, 15)));
    const referenceStart = new Date(referenceEnd.getTime() - 7 * 86_400_000);

    const startDate = referenceStart.toISOString().slice(0, 10);
    const endDate = referenceEnd.toISOString().slice(0, 10);

    const url = new URL('https://archive-api.open-meteo.com/v1/archive');
    url.searchParams.set('latitude', String(this.latitude));
    url.searchParams.set('longitude', String(this.longitude));
    url.searchParams.set('start_date', startDate);
    url.searchParams.set('end_date', endDate);
    url.searchParams.set(
      'hourly',
      'temperature_2m,relative_humidity_2m,precipitation,shortwave_radiation',
    );
    url.searchParams.set('timezone', 'UTC');

    try {
      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok) {
        throw new Error(`Open-Meteo HTTP ${res.status}`);
      }

      const json = (await res.json()) as OpenMeteoArchiveResponse;
      const hourly = json.hourly;
      const len = hourly?.time?.length ?? 0;
      if (!hourly || len < 24) {
        throw new Error('Open-Meteo returned insufficient hourly records');
      }

      const samples: HourlyWeatherSample[] = [];
      for (let i = 0; i < len; i++) {
        const temp = hourly.temperature_2m?.[i] ?? 22;
        const hum = hourly.relative_humidity_2m?.[i] ?? 70;
        const precip = hourly.precipitation?.[i] ?? 0;
        const radiationWm2 = hourly.shortwave_radiation?.[i] ?? 0;
        // Quy đổi bức xạ mặt trời ngắn sóng (W/m²) sang độ rọi (lux): ~115 lux / (W/m²)
        const lightLux = Math.max(0, Math.min(140000, radiationWm2 * 115));

        samples.push({
          temperatureCelsius: temp,
          humidityPercent: Math.min(100, Math.max(0, hum)),
          lightLux,
          precipitationMmPerHour: Math.max(0, precip),
        });
      }

      this.cachedSamples = samples;
      this.logger.info('Loaded historical weather series from Open-Meteo', {
        startDate,
        endDate,
        hoursLoaded: samples.length,
      });
    } catch (err) {
      this.logger.warn('Open-Meteo unavailable, falling back to synthetic diurnal weather model', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
