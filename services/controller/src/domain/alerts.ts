import { DEFAULT_THRESHOLDS, type AlertEvent, type Severity, type Thresholds, type ZoneState } from "@farm/shared";

export interface AlertRule {
  id: string;
  severity: Severity;
  /** Giá trị đo của luật; null = không đủ dữ liệu, giữ nguyên trạng thái hiện tại. */
  value: (z: ZoneState) => number | null;
  /** Điều kiện mở cảnh báo. */
  open: (v: number) => boolean;
  /** Điều kiện đóng (khác điều kiện mở: hysteresis). */
  close: (v: number) => boolean;
  message: (z: ZoneState, v: number) => string;
}

export interface AlertBook {
  open: Record<string, { alertId: string; openedAt: number }>;
  closedAt: Record<string, number>;
}
export const emptyBook = (): AlertBook => ({ open: {}, closedAt: {} });

const key = (zoneId: string, rule: string) => `${zoneId}:${rule}`;

export function defaultRules(th: Thresholds = DEFAULT_THRESHOLDS): AlertRule[] {
  return [
    {
      id: "soil_dry", severity: "warning",
      value: (z) => z.metrics.soilMoisture,
      open: (v) => v < th.dryBelow,
      close: (v) => v >= th.dryBelow + 4,
      message: (z, v) => `Zone ${z.zoneId} đang khô: độ ẩm đất ${v.toFixed(1)}%`,
    },
    {
      id: "soil_critical", severity: "critical",
      value: (z) => z.metrics.soilMoisture,
      open: (v) => v < th.criticalBelow,
      close: (v) => v >= th.criticalBelow + 4,
      message: (z, v) => `Zone ${z.zoneId} nguy cấp: độ ẩm đất ${v.toFixed(1)}%`,
    },
    {
      id: "zone_unknown", severity: "warning",
      value: (z) => (z.status === "unknown" ? 1 : 0),
      open: (v) => v === 1,
      close: (v) => v === 0,
      message: (z) => `Zone ${z.zoneId} mất dữ liệu cảm biến`,
    },
    {
      id: "fungal_risk", severity: "warning",
      value: (z) => z.derived.fungalRisk,
      open: (v) => v >= 0.7,
      close: (v) => v < 0.4,
      message: (z, v) => `Zone ${z.zoneId} nguy cơ nấm cao (${(v * 100).toFixed(0)}%)`,
    },
  ];
}

export function openAlert(
  book: AlertBook, zoneId: string, rule: string, severity: Severity,
  message: string, value: number | null, now: Date, cooldownSec: number,
): { book: AlertBook; event: AlertEvent | null } {
  const k = key(zoneId, rule);
  if (book.open[k]) return { book, event: null };
  const closed = book.closedAt[k];
  if (closed !== undefined && now.getTime() - closed < cooldownSec * 1000) return { book, event: null };
  const alertId = `${k}:${now.getTime()}`;
  return {
    book: { ...book, open: { ...book.open, [k]: { alertId, openedAt: now.getTime() } } },
    event: { alertId, zoneId, rule, severity, state: "open", message, value, ts: now.toISOString() },
  };
}

export function closeAlert(
  book: AlertBook, zoneId: string, rule: string, severity: Severity,
  message: string, value: number | null, now: Date,
): { book: AlertBook; event: AlertEvent | null } {
  const k = key(zoneId, rule);
  const cur = book.open[k];
  if (!cur) return { book, event: null };
  const { [k]: _gone, ...rest } = book.open;
  return {
    book: { open: rest, closedAt: { ...book.closedAt, [k]: now.getTime() } },
    event: { alertId: cur.alertId, zoneId, rule, severity, state: "closed", message, value, ts: now.toISOString() },
  };
}

/** Hàm thuần: so zone với các luật, trả sổ cảnh báo mới và các sự kiện mở/đóng. */
export function evaluateAlerts(
  book: AlertBook, zone: ZoneState, rules: AlertRule[], now: Date, cooldownSec = 600,
): { book: AlertBook; events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  let b = book;
  for (const r of rules) {
    const v = r.value(zone);
    if (v === null) continue;
    const isOpen = !!b.open[key(zone.zoneId, r.id)];
    if (!isOpen && r.open(v)) {
      const res = openAlert(b, zone.zoneId, r.id, r.severity, r.message(zone, v), v, now, cooldownSec);
      b = res.book; if (res.event) events.push(res.event);
    } else if (isOpen && r.close(v)) {
      const res = closeAlert(b, zone.zoneId, r.id, r.severity, `Đã ổn định: ${r.message(zone, v)}`, v, now);
      b = res.book; if (res.event) events.push(res.event);
    }
  }
  return { book: b, events };
}
