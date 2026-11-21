import { CanonicalUnit, SENSOR_SPECS, SensorType } from './schemas';

export interface NormalizedMeasurement {
  value: number;
  unit: CanonicalUnit;
}

/**
 * Chuẩn hóa giá trị và đơn vị thô về đơn vị chuẩn của hệ thống:
 * - soil_moisture / air_humidity -> 'percent' (hỗ trợ '%', 'percent', 'ratio' [0..1])
 * - air_temperature              -> 'celsius' (hỗ trợ 'c', '°c', 'celsius', 'f', '°f', 'fahrenheit', 'k', 'kelvin')
 * - light_intensity              -> 'lux'     (hỗ trợ 'lux', 'lx', 'klux')
 *
 * Trả về null nếu đơn vị không tương thích với loại cảm biến.
 */
export function normalizeSensorUnit(
  sensorType: SensorType,
  rawValue: number,
  rawUnit: string,
): NormalizedMeasurement | null {
  const normalizedUnitKey = rawUnit.trim().toLowerCase();
  const expectedUnit = SENSOR_SPECS[sensorType].canonicalUnit;

  if (expectedUnit === 'percent') {
    if (normalizedUnitKey === 'percent' || normalizedUnitKey === '%' || normalizedUnitKey === 'pct') {
      return { value: roundTo(rawValue, 2), unit: 'percent' };
    }
    if (normalizedUnitKey === 'ratio' || normalizedUnitKey === 'fraction') {
      return { value: roundTo(rawValue * 100, 2), unit: 'percent' };
    }
    return null;
  }

  if (expectedUnit === 'celsius') {
    if (normalizedUnitKey === 'celsius' || normalizedUnitKey === 'c' || normalizedUnitKey === '°c' || normalizedUnitKey === 'degc') {
      return { value: roundTo(rawValue, 2), unit: 'celsius' };
    }
    if (normalizedUnitKey === 'fahrenheit' || normalizedUnitKey === 'f' || normalizedUnitKey === '°f' || normalizedUnitKey === 'degf') {
      return { value: roundTo(((rawValue - 32) * 5) / 9, 2), unit: 'celsius' };
    }
    if (normalizedUnitKey === 'kelvin' || normalizedUnitKey === 'k') {
      return { value: roundTo(rawValue - 273.15, 2), unit: 'celsius' };
    }
    return null;
  }

  if (expectedUnit === 'lux') {
    if (normalizedUnitKey === 'lux' || normalizedUnitKey === 'lx') {
      return { value: roundTo(rawValue, 2), unit: 'lux' };
    }
    if (normalizedUnitKey === 'klux' || normalizedUnitKey === 'klx') {
      return { value: roundTo(rawValue * 1000, 2), unit: 'lux' };
    }
    return null;
  }

  return null;
}

function roundTo(val: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}
