import type { ValveCommandMessage, ZoneState } from "@digital-twin/shared";

/**
 * Luật tưới. Mốc độ ẩm lấy từ ngưỡng của chính zone (zone.thresholds):
 *   mở khi độ ẩm < dryBelow, đóng khi đạt optimalLow + stopFraction * (optimalHigh - optimalLow).
 * Các mốc thời gian cấu hình được qua biến môi trường (để chỉnh khi simulator chạy nhanh hơn thời gian thực).
 */
export interface IrrigationRules {
  /** 0..1: vị trí mục tiêu trong khoảng tối ưu. */
  stopFraction: number;
  maxRunSec: number;
  minRestSec: number;
  ackTimeoutSec: number;
}

export const DEFAULT_IRRIGATION: IrrigationRules = {
  stopFraction: 0.5, maxRunSec: 1800, minRestSec: 3600, ackTimeoutSec: 30,
};

/**
 * Đổi một mốc tính bằng giây "ruộng" sang giây thật mà máy trạng thái so sánh.
 * Làm tròn, tối thiểu 1 s (durationSec gửi simulator phải là số nguyên dương).
 */
export const toRealSeconds = (fieldSec: number, timeScale: number): number =>
  Math.max(1, Math.round(fieldSec / timeScale));

export const openBelow = (z: ZoneState) => z.thresholds.dryBelow;
export const stopAt = (z: ZoneState, r: IrrigationRules) =>
  z.thresholds.optimalLow + r.stopFraction * (z.thresholds.optimalHigh - z.thresholds.optimalLow);

export type ValvePhase = "idle" | "pending" | "watering" | "cooldown";
export interface ValveCtx {
  phase: ValvePhase;
  /** Thời điểm (ms) bắt đầu pha hiện tại. */
  since: number;
  /** Lệnh open của chu kỳ hiện tại. */
  commandId?: string;
}
export const initialValveCtx = (): ValveCtx => ({ phase: "idle", since: 0 });

export type ValveNote =
  | "open_issued" | "watering_started" | "ack_timeout" | "target_reached"
  | "max_run" | "data_lost" | "closed_externally" | "cooldown_over";

export interface ValveDecision {
  ctx: ValveCtx;
  command: ValveCommandMessage | null;
  note: ValveNote | null;
}

/** Quy ước tên van trong seed của Role A: valve-<zoneId>. */
export const actuatorIdFor = (zoneId: string) => `valve-${zoneId}`;

const mkCmd = (z: ZoneState, action: "open" | "close", reason: string, now: Date, durationSec?: number): ValveCommandMessage => ({
  commandId: `cmd-${z.zoneId}-${now.getTime()}-${action}`,
  farmId: z.farmId,
  zoneId: z.zoneId,
  actuatorId: actuatorIdFor(z.zoneId),
  action,
  durationSec,
  reason,
  issuedBy: "controller",
  ts: now.toISOString(),
});

/** Van đã xác nhận lệnh: ưu tiên khớp lastCommandId, nếu nguồn không gửi thì so thời điểm. */
function acked(zone: ZoneState, ctx: ValveCtx): boolean {
  if (zone.valve.state !== "open") return false;
  if (zone.valve.lastCommandId) return zone.valve.lastCommandId === ctx.commandId;
  return !!zone.valve.ts && Date.parse(zone.valve.ts) >= ctx.since;
}

/**
 * Máy trạng thái van: idle -> pending -> watering -> cooldown -> idle.
 * An toàn: thiếu dữ liệu thì không mở; đang tưới mà mất dữ liệu thì đóng; van không phản hồi thì gửi lệnh đóng.
 */
export function decide(zone: ZoneState, ctx: ValveCtx, rules: IrrigationRules, now: Date): ValveDecision {
  const t = now.getTime();
  const m = zone.metrics.soilMoisture;
  const elapsed = (t - ctx.since) / 1000;
  const keep = (note: ValveNote | null = null): ValveDecision => ({ ctx, command: null, note });
  const to = (phase: ValvePhase, command: ValveCommandMessage | null, note: ValveNote | null, commandId = ctx.commandId): ValveDecision =>
    ({ ctx: { phase, since: t, commandId }, command, note });

  switch (ctx.phase) {
    case "idle": {
      if (m === null) return keep();
      if (zone.valve.state === "open") return keep(); // van đang mở do nguồn khác
      if (m < openBelow(zone)) {
        const cmd = mkCmd(zone, "open", `độ ẩm ${m.toFixed(1)}% < ${openBelow(zone)}%`, now, rules.maxRunSec);
        return to("pending", cmd, "open_issued", cmd.commandId);
      }
      return keep();
    }
    case "pending": {
      if (acked(zone, ctx)) return to("watering", null, "watering_started");
      if (elapsed > rules.ackTimeoutSec)
        return to("cooldown", mkCmd(zone, "close", "van không xác nhận lệnh mở, đóng để an toàn", now), "ack_timeout");
      return keep();
    }
    case "watering": {
      const close = (reason: string, note: ValveNote) => to("cooldown", mkCmd(zone, "close", reason, now), note);
      const target = stopAt(zone, rules);
      if (m === null) return close("mất dữ liệu cảm biến, đóng van an toàn", "data_lost");
      if (m >= target) return close(`đạt ${m.toFixed(1)}% >= ${target.toFixed(1)}%`, "target_reached");
      if (elapsed >= rules.maxRunSec) return close(`quá ${rules.maxRunSec}s`, "max_run");
      if (zone.valve.state === "closed" && !!zone.valve.ts && Date.parse(zone.valve.ts) > ctx.since)
        return to("cooldown", null, "closed_externally");
      return keep();
    }
    case "cooldown":
      return elapsed >= rules.minRestSec ? to("idle", null, "cooldown_over") : keep();
  }
}

export type CommandStatus = "sent" | "acknowledged" | "completed" | "failed";
export interface CommandRecord { cmd: ValveCommandMessage; status: CommandStatus; }

/** Lệnh close đã gửi, chờ van xác nhận đã đóng. */
export interface PendingClose { commandId: string; since: number; timedOut: boolean; }

/**
 * Theo dõi lệnh close: "confirmed" khi van báo closed (khớp commandId, hoặc ts mới hơn lệnh nếu nguồn không gửi id);
 * "timeout" MỘT lần khi quá ackTimeoutSec mà chưa xác nhận (vẫn tiếp tục chờ, xác nhận muộn vẫn được ghi nhận).
 */
export function closeAck(zone: ZoneState, p: PendingClose, rules: IrrigationRules, now: Date): "confirmed" | "timeout" | null {
  const v = zone.valve;
  if (v.state === "closed") {
    if (v.lastCommandId ? v.lastCommandId === p.commandId : !!v.ts && Date.parse(v.ts) >= p.since) return "confirmed";
  }
  if (!p.timedOut && (now.getTime() - p.since) / 1000 > rules.ackTimeoutSec) return "timeout";
  return null;
}

/** Lệnh close còn chờ xác nhận lúc controller khởi động lại (lệnh gần nhất của zone là close, trạng thái sent). */
export function restorePendingClose(last: CommandRecord | undefined): PendingClose | undefined {
  if (!last || last.cmd.action !== "close" || last.status !== "sent") return undefined;
  return { commandId: last.cmd.commandId, since: Date.parse(last.cmd.ts), timedOut: false };
}

/** Dựng lại pha van sau khi controller khởi động lại, từ lệnh gần nhất của zone (bảng commands). */
export function restoreValveCtx(last: CommandRecord | undefined, rules: IrrigationRules, now: Date): ValveCtx {
  if (!last) return initialValveCtx();
  const since = Date.parse(last.cmd.ts);
  const age = (now.getTime() - since) / 1000;
  const cooldownOrIdle = (): ValveCtx => (age < rules.minRestSec ? { phase: "cooldown", since } : initialValveCtx());
  if (last.cmd.action === "open" && last.status === "sent")
    return age <= rules.ackTimeoutSec ? { phase: "pending", since, commandId: last.cmd.commandId } : cooldownOrIdle();
  if (last.cmd.action === "open" && last.status === "acknowledged")
    return age < rules.maxRunSec ? { phase: "watering", since, commandId: last.cmd.commandId } : cooldownOrIdle();
  return cooldownOrIdle();
}
