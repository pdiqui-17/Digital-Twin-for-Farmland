import { type Command, type ZoneState } from "@farm/shared";

export interface IrrigationRules {
  /** Mở van khi độ ẩm đất thấp hơn mức này. */
  openBelow: number;
  /** Đóng van khi đạt mức này. */
  stopAt: number;
  maxRunSec: number;
  minRestSec: number;
  ackTimeoutSec: number;
  /** Không tưới khi mưa >= mức này (mm/h). */
  skipRainMmH: number;
}

export const DEFAULT_IRRIGATION: IrrigationRules = {
  openBelow: 26, stopAt: 34, maxRunSec: 1800, minRestSec: 3600, ackTimeoutSec: 30, skipRainMmH: 0.5,
};

export type ValvePhase = "idle" | "pending" | "watering" | "cooldown";
export interface ValveCtx {
  phase: ValvePhase;
  /** Thời điểm (ms) bắt đầu pha hiện tại. */
  since: number;
  commandId?: string;
}
export const initialValveCtx = (): ValveCtx => ({ phase: "idle", since: 0 });

export type ValveNote =
  | "open_issued" | "watering_started" | "ack_timeout" | "target_reached"
  | "max_run" | "data_lost" | "closed_externally" | "cooldown_over";

export interface ValveDecision {
  ctx: ValveCtx;
  command: Command | null;
  note: ValveNote | null;
}

const mkCmd = (z: ZoneState, action: "open" | "close", reason: string, now: Date, durationSec?: number): Command => ({
  commandId: `cmd-${z.zoneId}-${now.getTime()}-${action}`,
  zoneId: z.zoneId, farmId: z.farmId, action, durationSec, reason, ts: now.toISOString(),
});

/**
 * Máy trạng thái van: idle -> pending -> watering -> cooldown -> idle.
 * An toàn: thiếu dữ liệu thì không mở; đang tưới mà mất dữ liệu thì đóng.
 */
export function decide(zone: ZoneState, ctx: ValveCtx, rules: IrrigationRules, now: Date): ValveDecision {
  const t = now.getTime();
  const m = zone.metrics.soilMoisture;
  const elapsed = (t - ctx.since) / 1000;
  const keep = (note: ValveNote | null = null): ValveDecision => ({ ctx, command: null, note });
  const to = (phase: ValvePhase, command: Command | null, note: ValveNote | null, commandId = ctx.commandId): ValveDecision =>
    ({ ctx: { phase, since: t, commandId }, command, note });

  switch (ctx.phase) {
    case "idle": {
      if (m === null) return keep();
      if (zone.valve.state === "open") return keep(); // van đang mở do nguồn khác
      if ((zone.metrics.rain ?? 0) >= rules.skipRainMmH) return keep();
      if (m < rules.openBelow) {
        const cmd = mkCmd(zone, "open", `độ ẩm ${m.toFixed(1)}% < ${rules.openBelow}%`, now, rules.maxRunSec);
        return to("pending", cmd, "open_issued", cmd.commandId);
      }
      return keep();
    }
    case "pending": {
      const acked = zone.valve.state === "open" && !!zone.valve.ts && Date.parse(zone.valve.ts) >= ctx.since;
      if (acked) return to("watering", null, "watering_started");
      if (elapsed > rules.ackTimeoutSec) return to("cooldown", null, "ack_timeout");
      return keep();
    }
    case "watering": {
      const close = (reason: string, note: ValveNote) => to("cooldown", mkCmd(zone, "close", reason, now), note);
      if (m === null) return close("mất dữ liệu cảm biến, đóng van an toàn", "data_lost");
      if (m >= rules.stopAt) return close(`đạt ${m.toFixed(1)}% >= ${rules.stopAt}%`, "target_reached");
      if (elapsed >= rules.maxRunSec) return close(`quá ${rules.maxRunSec}s`, "max_run");
      if (zone.valve.state === "closed" && !!zone.valve.ts && Date.parse(zone.valve.ts) > ctx.since)
        return to("cooldown", null, "closed_externally");
      return keep();
    }
    case "cooldown":
      return elapsed >= rules.minRestSec ? to("idle", null, "cooldown_over") : keep();
  }
}
