import type { AlertEvent, AlertSeverity, TwinAlertEvent, ZoneState } from "@digital-twin/shared";

type Category = AlertEvent["category"];

export interface AlertRule {
  id: string;
  severity: AlertSeverity;
  /** Nhóm cảnh báo theo hợp đồng của Role A (cột alerts.category). */
  category: Category;
  /** Giá trị đo của luật; null = không đủ dữ liệu, giữ nguyên trạng thái hiện tại. */
  value: (z: ZoneState) => number | null;
  /** Điều kiện mở cảnh báo. */
  open: (v: number, z: ZoneState) => boolean;
  /** Điều kiện đóng (khác điều kiện mở: hysteresis). */
  close: (v: number, z: ZoneState) => boolean;
  message: (z: ZoneState, v: number) => string;
}

export interface AlertBook {
  open: Record<string, { alertId: string; openedAt: number }>;
  closedAt: Record<string, number>;
}
export const emptyBook = (): AlertBook => ({ open: {}, closedAt: {} });

const key = (zoneId: string, rule: string) => `${zoneId}:${rule}`;

/** Khoảng hysteresis cho luật độ ẩm (điểm %). */
export const MOISTURE_HYSTERESIS = 4;

/** Luật mặc định. Ngưỡng độ ẩm lấy theo từng zone (zone.thresholds). */
export function defaultRules(): AlertRule[] {
  return [
    {
      id: "soil_dry", severity: "warning", category: "water_stress",
      value: (z) => z.metrics.soilMoisture,
      open: (v, z) => v < z.thresholds.dryBelow,
      close: (v, z) => v >= z.thresholds.dryBelow + MOISTURE_HYSTERESIS,
      message: (z, v) => `Zone ${z.zoneId} đang khô: độ ẩm đất ${v.toFixed(1)}% (tối ưu ${z.thresholds.optimalLow}-${z.thresholds.optimalHigh}%)`,
    },
    {
      id: "soil_critical", severity: "critical", category: "drought",
      value: (z) => z.metrics.soilMoisture,
      open: (v, z) => v < z.thresholds.criticalBelow,
      close: (v, z) => v >= z.thresholds.criticalBelow + MOISTURE_HYSTERESIS,
      message: (z, v) => `Zone ${z.zoneId} nguy cấp: độ ẩm đất ${v.toFixed(1)}%`,
    },
    {
      id: "zone_unknown", severity: "warning", category: "sensor_fault",
      value: (z) => (z.status === "unknown" ? 1 : 0),
      open: (v) => v === 1,
      close: (v) => v === 0,
      message: (z) => `Zone ${z.zoneId} mất dữ liệu độ ẩm đất`,
    },
    {
      id: "sensor_fault", severity: "warning", category: "sensor_fault",
      value: (z) => z.faultySensors.length,
      open: (v) => v >= 1,
      close: (v) => v === 0,
      message: (z, v) => (v > 0 ? `Zone ${z.zoneId} có ${v} cảm biến lỗi: ${z.faultySensors.join(", ")}` : `Zone ${z.zoneId} các cảm biến đã bình thường`),
    },
    {
      id: "fungal_risk", severity: "warning", category: "fungal_risk",
      value: (z) => z.derived.fungalRisk,
      open: (v) => v >= 0.7,
      close: (v) => v < 0.4,
      message: (z, v) => `Zone ${z.zoneId} nguy cơ nấm cao (${(v * 100).toFixed(0)}%)`,
    },
  ];
}

export interface AlertSpec {
  zoneId: string; farmId: string; rule: string; severity: AlertSeverity; category: Category;
  message: string; value: number | null;
}

export function openAlert(book: AlertBook, s: AlertSpec, now: Date, cooldownSec: number): { book: AlertBook; event: TwinAlertEvent | null } {
  const k = key(s.zoneId, s.rule);
  if (book.open[k]) return { book, event: null };
  const closed = book.closedAt[k];
  if (closed !== undefined && now.getTime() - closed < cooldownSec * 1000) return { book, event: null };
  const alertId = `${k}:${now.getTime()}`;
  return {
    book: { ...book, open: { ...book.open, [k]: { alertId, openedAt: now.getTime() } } },
    event: { alertId, ...s, state: "open", ts: now.toISOString() },
  };
}

export function closeAlert(book: AlertBook, s: AlertSpec, now: Date): { book: AlertBook; event: TwinAlertEvent | null } {
  const k = key(s.zoneId, s.rule);
  const cur = book.open[k];
  if (!cur) return { book, event: null };
  const { [k]: _gone, ...rest } = book.open;
  return {
    book: { open: rest, closedAt: { ...book.closedAt, [k]: now.getTime() } },
    event: { alertId: cur.alertId, ...s, state: "closed", ts: now.toISOString() },
  };
}

/** Hàm thuần: so zone với các luật, trả sổ cảnh báo mới và các sự kiện mở/đóng. */
export function evaluateAlerts(
  book: AlertBook, zone: ZoneState, rules: AlertRule[], now: Date, cooldownSec = 600,
): { book: AlertBook; events: TwinAlertEvent[] } {
  const events: TwinAlertEvent[] = [];
  let b = book;
  for (const r of rules) {
    const v = r.value(zone);
    if (v === null) continue;
    const spec = (message: string): AlertSpec => ({
      zoneId: zone.zoneId, farmId: zone.farmId, rule: r.id, severity: r.severity, category: r.category, message, value: v,
    });
    const isOpen = !!b.open[key(zone.zoneId, r.id)];
    if (!isOpen && r.open(v, zone)) {
      const res = openAlert(b, spec(r.message(zone, v)), now, cooldownSec);
      b = res.book; if (res.event) events.push(res.event);
    } else if (isOpen && r.close(v, zone)) {
      const res = closeAlert(b, spec(`Đã ổn định: ${r.message(zone, v)}`), now);
      b = res.book; if (res.event) events.push(res.event);
    }
  }
  return { book: b, events };
}

export interface OpenAlertRow { alertId: string; zoneId: string; rule: string; ts: string; }

/** Dựng lại sổ cảnh báo sau khi controller khởi động lại, từ các cảnh báo còn mở trong DB. */
export function restoreBook(rows: OpenAlertRow[]): AlertBook {
  const book = emptyBook();
  for (const r of rows) book.open[key(r.zoneId, r.rule)] = { alertId: r.alertId, openedAt: Date.parse(r.ts) };
  return book;
}
