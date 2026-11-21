import type { HourlyWeather } from "./weather";
import { simulate, type Params } from "./waterBalance";

export interface IrrigationWindow {
  /** Giờ bắt đầu, tính từ bây giờ (0 = ngay). */
  startHour: number;
  durationHours: number;
}

export function scheduleToOpen(windows: IrrigationWindow[], horizonHours: number): (0 | 1)[] {
  const open = new Array<0 | 1>(horizonHours).fill(0);
  for (const w of windows)
    for (let h = Math.max(0, Math.floor(w.startHour)); h < Math.min(horizonHours, w.startHour + w.durationHours); h++) open[h] = 1;
  return open;
}

export interface ForecastPoint { hour: number; moisture: number; }

/** Dự đoán độ ẩm theo giờ cho horizonHours giờ tới với thời tiết và lịch tưới cho trước. */
export function forecast(
  m0: number, params: Params, weather: HourlyWeather[], windows: IrrigationWindow[],
  horizonHours: number, fieldCapacity: number,
): ForecastPoint[] {
  const open = scheduleToOpen(windows, horizonHours);
  const inputs = Array.from({ length: horizonHours }, (_, h) => {
    const w = weather[h] ?? weather[weather.length - 1] ?? { temp: 25, rain: 0 };
    return { temp: w.temp, rain: w.rain, open: open[h]! };
  });
  return simulate(m0, params, inputs, 1, fieldCapacity).map((moisture, i) => ({ hour: i + 1, moisture }));
}
