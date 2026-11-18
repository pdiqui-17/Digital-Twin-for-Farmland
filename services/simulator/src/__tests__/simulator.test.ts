import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, SENSOR_SPECS, SensorTelemetryMessageSchema } from '@digital-twin/shared';
import { FarmEngine } from '../domain/farmEngine';
import { SensorGenerator } from '../domain/sensorGenerator';
import { WeatherProvider } from '../domain/weatherProvider';

const silentLogger = createLogger('simulator-test', 'error');

test('Drought mode reduces soil moisture significantly and sandy soil dries faster than clay', () => {
  const weatherProvider = new WeatherProvider(11.9404, 108.4583, false, silentLogger);
  const engine = new FarmEngine('farm-01', 4, true);

  const initialB = engine.getZone('zone-B')!.rootSoilMoisture; // sandy
  const initialD = engine.getZone('zone-D')!.rootSoilMoisture; // clay

  // Mô phỏng 12 nhịp x 10 phút vật lý (2 giờ nắng hạn buổi trưa 13:00 giờ VN = 06:00 UTC)
  const noonUtc = new Date('2026-05-10T06:00:00Z');
  for (let i = 0; i < 12; i++) {
    const ambient = weatherProvider.getWeatherAt(noonUtc, true);
    engine.stepPhysics(ambient, 10, noonUtc.getTime() + i * 5000);
  }

  const finalB = engine.getZone('zone-B')!.rootSoilMoisture;
  const finalD = engine.getZone('zone-D')!.rootSoilMoisture;

  const dropB = initialB - finalB;
  const dropD = initialD - finalD;

  assert.ok(dropB > 4.0, `Expected sandy zone-B moisture to drop > 4%, got ${dropB}`);
  assert.ok(dropD > 2.0, `Expected clay zone-D moisture to drop > 2%, got ${dropD}`);
  assert.ok(dropB > dropD, `Expected sandy soil (${dropB}) to dry faster than clay (${dropD})`);
});

test('Virtual irrigation valve increases soil moisture when open and auto-closes after durationSec', () => {
  const weatherProvider = new WeatherProvider(11.9404, 108.4583, false, silentLogger);
  const engine = new FarmEngine('farm-01', 4, false);

  const startMs = Date.parse('2026-05-10T08:00:00Z');
  const beforeMoisture = engine.getZone('zone-A')!.rootSoilMoisture;

  const openState = engine.applyValveCommand(
    {
      commandId: 'cmd-test-1',
      farmId: 'farm-01',
      zoneId: 'zone-A',
      action: 'open',
      durationSec: 20,
      issuedBy: 'test',
      ts: new Date(startMs).toISOString(),
    },
    startMs,
  );

  assert.ok(openState);
  assert.equal(openState.state, 'open');

  // Chạy 3 nhịp trong 15 giây thực (van vẫn đang mở)
  for (let step = 1; step <= 3; step++) {
    const ambient = weatherProvider.getWeatherAt(new Date(startMs), false);
    const closed = engine.stepPhysics(ambient, 5, startMs + step * 5000);
    assert.equal(closed.length, 0);
  }

  const afterMoisture = engine.getZone('zone-A')!.rootSoilMoisture;
  assert.ok(
    afterMoisture > beforeMoisture + 2.0,
    `Expected irrigation to raise zone-A moisture from ${beforeMoisture} to > ${beforeMoisture + 2}, got ${afterMoisture}`,
  );

  // Tới giây thứ 25 (>= durationSec 20s) -> van phải tự động đóng và trả về thông báo state
  const ambient = weatherProvider.getWeatherAt(new Date(startMs), false);
  const autoClosed = engine.stepPhysics(ambient, 5, startMs + 25_000);
  assert.equal(autoClosed.length, 1);
  assert.equal(autoClosed[0].zoneId, 'zone-A');
  assert.equal(autoClosed[0].state, 'closed');
  assert.equal(engine.getZone('zone-A')!.valve.state, 'closed');
});

test('SensorGenerator supports fault injection (dropout, stuck, out_of_range)', () => {
  const engine = new FarmEngine('farm-01', 4, false);
  const generator = new SensorGenerator('farm-01', engine.getZones(), 0, 0, 0);

  assert.equal(generator.setSensorFault('s-A-moisture', 'dropout'), true);
  assert.equal(generator.setSensorFault('s-B-temp', 'stuck'), true);
  assert.equal(generator.setSensorFault('s-C-moisture', 'out_of_range'), true);

  const batch1 = generator.generateReadings(engine.getZones(), new Date('2026-05-10T08:00:00Z'));
  assert.equal(batch1.droppedSensors.length, 1);
  assert.equal(batch1.droppedSensors[0].sensorId, 's-A-moisture');
  assert.equal(batch1.publishedMessages.some((m) => m.sensorId === 's-A-moisture'), false);

  const stuck1 = batch1.publishedMessages.find((m) => m.sensorId === 's-B-temp')!;
  const spike1 = batch1.publishedMessages.find((m) => m.sensorId === 's-C-moisture')!;
  assert.ok(
    spike1.value < SENSOR_SPECS.soil_moisture.minValid ||
      spike1.value > SENSOR_SPECS.soil_moisture.maxValid,
    `Expected out_of_range spike outside [0, 100], got ${spike1.value}`,
  );

  // Thay đổi nhiệt độ thực của zone-B nhưng cảm biến bị stuck vẫn phải giữ nguyên giá trị cũ
  engine.getZone('zone-B')!.airTemperature += 8.0;
  const batch2 = generator.generateReadings(engine.getZones(), new Date('2026-05-10T08:00:05Z'));
  const stuck2 = batch2.publishedMessages.find((m) => m.sensorId === 's-B-temp')!;
  assert.equal(stuck2.value, stuck1.value);
});

test('SensorGenerator scales cleanly to 500+ virtual sensors with valid schemas', () => {
  const engine = new FarmEngine('farm-01', 4, false);
  // 4 zones * (4 base + 125 virtual) = 516 sensors
  const generator = new SensorGenerator('farm-01', engine.getZones(), 125, 0.1, 0);

  assert.equal(generator.getTotalSensorCount(), 516);

  const t0 = performance.now();
  const batch = generator.generateReadings(engine.getZones(), new Date());
  const elapsedMs = performance.now() - t0;

  assert.equal(batch.publishedMessages.length, 516);
  assert.ok(elapsedMs < 200, `Expected 516 sensor readings in <200ms, took ${elapsedMs}ms`);

  for (const msg of batch.publishedMessages) {
    const parsed = SensorTelemetryMessageSchema.safeParse(msg);
    assert.equal(parsed.success, true);
  }
});
