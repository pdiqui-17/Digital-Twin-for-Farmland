import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlertEventSchema,
  DEFAULT_THRESHOLDS,
  TwinAlertEventSchema,
  ZoneStateSchema,
  deriveThresholds,
  isUsableQuality,
} from '../index';

test('deriveThresholds follows the zone optimal range from the catalog', () => {
  const th = deriveThresholds(55, 80);
  assert.equal(th.dryBelow, 55);
  assert.equal(th.criticalBelow, 45);
  assert.equal(th.wiltingPoint, 35);
  assert.equal(th.fieldCapacity, 90);
  assert.equal(deriveThresholds(5, 95).wiltingPoint, 0);
  assert.equal(deriveThresholds(5, 95).fieldCapacity, 100);
});

test('only ok and noisy_smoothed are usable business values', () => {
  assert.equal(isUsableQuality('ok'), true);
  assert.equal(isUsableQuality('noisy_smoothed'), true);
  assert.equal(isUsableQuality('out_of_range'), false);
  assert.equal(isUsableQuality('stuck'), false);
  assert.equal(isUsableQuality('missing_signal'), false);
});

test('TwinAlertEvent stays compatible with Role A AlertEventSchema', () => {
  const e = {
    alertId: 'zone-B:soil_dry:1', farmId: 'farm-01', zoneId: 'zone-B', severity: 'warning',
    category: 'water_stress', message: 'dry', ts: '2026-05-10T08:00:00.000Z',
    rule: 'soil_dry', state: 'open', value: 51.2,
  };
  assert.equal(TwinAlertEventSchema.safeParse(e).success, true);
  assert.equal(AlertEventSchema.safeParse(e).success, true);
});

test('ZoneStateSchema accepts an empty twin', () => {
  const z = {
    zoneId: 'zone-A', farmId: 'farm-01', updatedAt: '2026-05-10T08:00:00.000Z', lastDataAt: null, sensors: {},
    metrics: { soilMoisture: null, airTemperature: null, airHumidity: null, lightIntensity: null },
    derived: { waterStress: null, fungalRisk: 0, fungalAccumMin: 0 }, faultySensors: [],
    valve: { state: 'unknown', ts: null }, thresholds: DEFAULT_THRESHOLDS, status: 'unknown',
  };
  assert.equal(ZoneStateSchema.safeParse(z).success, true);
});
