import test from 'node:test';
import assert from 'node:assert/strict';
import { RawTelemetryEnvelope } from '@digital-twin/shared';
import { TelemetryCleaner } from '../domain/telemetryCleaner';

function makeEnvelope(
  sensorId: string,
  zoneId: string,
  payloadObj: unknown,
  receivedAt = '2026-05-10T08:00:00Z',
): RawTelemetryEnvelope {
  return {
    mqttTopic: `farm/farm-01/zone/${zoneId}/sensor/${sensorId}/telemetry`,
    farmId: 'farm-01',
    zoneId,
    sensorId,
    receivedAt,
    rawPayload: typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj),
  };
}

test('TelemetryCleaner normalizes units (°F -> celsius, klux -> lux) and preserves rawValue', () => {
  const cleaner = new TelemetryCleaner({
    stuckThresholdCount: 4,
    missingSignalTimeoutMs: 15000,
  });

  const res = cleaner.processEnvelope(
    makeEnvelope('s-A-temp', 'zone-A', {
      sensorId: 's-A-temp',
      zoneId: 'zone-A',
      type: 'air_temperature',
      value: 77,
      unit: '°F',
      ts: '2026-05-10T08:00:00Z',
      quality: 'ok',
    }),
  );

  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.value, 25);
    assert.equal(res.data.rawValue, 77);
    assert.equal(res.data.unit, 'celsius');
    assert.equal(res.data.quality, 'ok');
  }
});

test('TelemetryCleaner flags out_of_range spikes without corrupting subsequent EMA history', () => {
  const cleaner = new TelemetryCleaner({
    stuckThresholdCount: 4,
    missingSignalTimeoutMs: 15000,
  });

  // Lần 1: hợp lệ 55%
  const r1 = cleaner.processEnvelope(
    makeEnvelope('s-A-moisture', 'zone-A', {
      sensorId: 's-A-moisture',
      zoneId: 'zone-A',
      type: 'soil_moisture',
      value: 55.0,
      unit: 'percent',
      ts: '2026-05-10T08:00:00Z',
    }),
  );
  assert.equal(r1.ok && r1.data.quality, 'ok');

  // Lần 2: vọt lố 135% -> out_of_range
  const r2 = cleaner.processEnvelope(
    makeEnvelope('s-A-moisture', 'zone-A', {
      sensorId: 's-A-moisture',
      zoneId: 'zone-A',
      type: 'soil_moisture',
      value: 135.0,
      unit: 'percent',
      ts: '2026-05-10T08:00:05Z',
    }),
  );
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.data.quality, 'out_of_range');
  }

  // Lần 3: trở lại bình thường 55.4% -> vẫn phải 'ok' (không bị kéo lệch bởi 135%)
  const r3 = cleaner.processEnvelope(
    makeEnvelope('s-A-moisture', 'zone-A', {
      sensorId: 's-A-moisture',
      zoneId: 'zone-A',
      type: 'soil_moisture',
      value: 55.4,
      unit: 'percent',
      ts: '2026-05-10T08:00:10Z',
    }),
  );
  assert.equal(r3.ok, true);
  if (r3.ok) {
    assert.equal(r3.data.quality, 'ok');
    assert.equal(r3.data.value, 55.4);
  }
});

test('TelemetryCleaner detects stuck sensor values while exempting nighttime 0 lux', () => {
  const cleaner = new TelemetryCleaner({
    stuckThresholdCount: 3,
    missingSignalTimeoutMs: 15000,
  });

  // Cảm biến nhiệt độ kẹt cứng ở 24.5°C trong 3 chu kỳ
  for (let i = 1; i <= 3; i++) {
    const res = cleaner.processEnvelope(
      makeEnvelope('s-B-temp', 'zone-B', {
        sensorId: 's-B-temp',
        zoneId: 'zone-B',
        type: 'air_temperature',
        value: 24.5,
        unit: 'celsius',
        ts: `2026-05-10T08:00:0${i}Z`,
      }),
    );
    assert.equal(res.ok, true);
    if (res.ok && i === 3) {
      assert.equal(res.data.quality, 'stuck');
    }
  }

  // Cảm biến ánh sáng = 0 lux ban đêm 4 lần liên tiếp vẫn phải 'ok', không báo nhầm 'stuck'
  for (let i = 1; i <= 4; i++) {
    const lightRes = cleaner.processEnvelope(
      makeEnvelope('s-B-light', 'zone-B', {
        sensorId: 's-B-light',
        zoneId: 'zone-B',
        type: 'light_intensity',
        value: 0,
        unit: 'lux',
        ts: `2026-05-10T18:00:0${i}Z`,
      }),
    );
    assert.equal(lightRes.ok, true);
    if (lightRes.ok) {
      assert.equal(lightRes.data.quality, 'ok');
    }
  }
});

test('TelemetryCleaner smooths abrupt in-range noise spikes and detects missing_signal timeout', () => {
  const cleaner = new TelemetryCleaner({
    stuckThresholdCount: 5,
    missingSignalTimeoutMs: 10000,
  });

  const t0 = Date.parse('2026-05-10T08:00:00Z');
  cleaner.processEnvelope(
    makeEnvelope('s-C-moisture', 'zone-C', {
      sensorId: 's-C-moisture',
      zoneId: 'zone-C',
      type: 'soil_moisture',
      value: 50.0,
      unit: 'percent',
      ts: new Date(t0).toISOString(),
    }),
    t0,
  );

  // Nhảy vọt từ 50% lên 72% trong 5 giây (vẫn trong [0, 100] nhưng vượt MAX_PLAUSIBLE_STEP_DELTA 8.5%)
  const spikeRes = cleaner.processEnvelope(
    makeEnvelope('s-C-moisture', 'zone-C', {
      sensorId: 's-C-moisture',
      zoneId: 'zone-C',
      type: 'soil_moisture',
      value: 72.0,
      unit: 'percent',
      ts: new Date(t0 + 5000).toISOString(),
    }),
    t0 + 5000,
  );
  assert.equal(spikeRes.ok, true);
  if (spikeRes.ok) {
    assert.equal(spikeRes.data.quality, 'noisy_smoothed');
    assert.ok(spikeRes.data.value > 50 && spikeRes.data.value < 72);
    assert.equal(spikeRes.data.rawValue, 72.0);
  }

  // Sau 15 giây không có tin mới (> timeout 10s) -> phát cảnh báo missing_signal đúng 1 lần
  const missing1 = cleaner.detectMissingSignals(t0 + 20_000);
  assert.equal(missing1.length, 1);
  assert.equal(missing1[0].sensorId, 's-C-moisture');
  assert.equal(missing1[0].quality, 'missing_signal');

  const missing2 = cleaner.detectMissingSignals(t0 + 25_000);
  assert.equal(missing2.length, 0);
});
