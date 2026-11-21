import type { TwinAlertEvent, ZoneState } from "@digital-twin/shared";
import { closeAlert, defaultRules, emptyBook, evaluateAlerts, openAlert, restoreBook, type AlertBook, type AlertRule, type AlertSpec } from "./domain/alerts";
import {
  DEFAULT_IRRIGATION, closeAck, decide, initialValveCtx, needsPrediction, restorePendingClose, restoreValveCtx,
  type IrrigationRules, type PendingClose, type Prediction, type ValveCtx, type ValveNote,
} from "./domain/valve";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, ForecastSource, Notifier, TwinSource } from "./adapters/ports";

export interface ControllerDeps {
  twin: TwinSource;
  commandPublisher: CommandPublisher;
  commandStore: CommandStore;
  alertStore: AlertStore;
  alertPublisher: AlertPublisher;
  notifier: Notifier;
  irrigation?: IrrigationRules;
  alertRules?: AlertRule[];
  alertCooldownSec?: number;
  /** Tắt tự động tưới (chỉ cảnh báo). */
  autoIrrigation?: boolean;
  /** Có thì bật luật tưới sớm theo dự đoán; lỗi/không có dự đoán thì chỉ dùng luật theo ngưỡng. */
  forecast?: ForecastSource;
  /** Tầm dự đoán, giờ ruộng. Mặc định 1. */
  predictHours?: number;
  /** Báo kết quả mỗi lần hỏi dự đoán (metrics). */
  onPrediction?: (result: "ok" | "none" | "error") => void;
}

/** Ghi chú của máy trạng thái -> trạng thái mới của lệnh open trong bảng commands. */
const STATUS_ON: Partial<Record<ValveNote, "acknowledged" | "completed" | "failed">> = {
  watering_started: "acknowledged",
  target_reached: "completed",
  max_run: "completed",
  data_lost: "completed",
  closed_externally: "completed",
  ack_timeout: "failed",
};

/** Vòng điều khiển: mỗi tick đọc twin, quyết định lệnh van và đánh giá cảnh báo. */
export class Controller {
  private ctx = new Map<string, ValveCtx>();
  /** Lệnh close đang chờ van xác nhận, theo zone. */
  private pendingClose = new Map<string, PendingClose>();
  private book: AlertBook = emptyBook();
  private rules: AlertRule[];
  private irrigation: IrrigationRules;

  constructor(private d: ControllerDeps) {
    this.rules = d.alertRules ?? defaultRules();
    this.irrigation = d.irrigation ?? DEFAULT_IRRIGATION;
  }

  /** Khôi phục pha van và cảnh báo đang mở từ DB (gọi một lần khi khởi động). */
  async restore(now: Date = new Date()): Promise<void> {
    for (const rec of await this.d.commandStore.latestPerZone()) {
      this.ctx.set(rec.cmd.zoneId, restoreValveCtx(rec, this.irrigation, now));
      const pc = restorePendingClose(rec);
      if (pc) this.pendingClose.set(rec.cmd.zoneId, pc);
    }
    this.book = restoreBook(await this.d.alertStore.loadOpen());
  }

  private async emit(e: TwinAlertEvent) {
    await this.d.alertStore.upsert(e);
    await this.d.alertPublisher.publish(e);
    await this.d.notifier.notify(e);
  }

  private valveAlertSpec(zone: ZoneState, message: string): AlertSpec {
    return { zoneId: zone.zoneId, farmId: zone.farmId, rule: "valve_ack_timeout", severity: "warning", category: "system", message, value: null };
  }

  async tick(now: Date = new Date()): Promise<void> {
    const zones = await this.d.twin.zones();
    for (const zone of zones) {
      // 1) Cảnh báo theo luật
      const ev = evaluateAlerts(this.book, zone, this.rules, now, this.d.alertCooldownSec);
      this.book = ev.book;
      for (const e of ev.events) await this.emit(e);

      // 2) Lệnh close đang chờ: van đã đóng thật chưa?
      const pc = this.pendingClose.get(zone.zoneId);
      if (pc) {
        const ack = closeAck(zone, pc, this.irrigation, now);
        if (ack === "confirmed") {
          this.pendingClose.delete(zone.zoneId);
          await this.d.commandStore.setStatus(pc.commandId, "completed", now);
          const r = closeAlert(this.book, this.valveAlertSpec(zone, `Zone ${zone.zoneId}: van đã xác nhận đóng`), now);
          this.book = r.book; if (r.event) await this.emit(r.event);
        } else if (ack === "timeout") {
          this.pendingClose.set(zone.zoneId, { ...pc, timedOut: true });
          await this.d.commandStore.setStatus(pc.commandId, "failed", now);
          const r = openAlert(this.book, this.valveAlertSpec(zone, `Zone ${zone.zoneId}: van không xác nhận lệnh đóng, có thể vẫn đang tưới`), now, this.d.alertCooldownSec ?? 600);
          this.book = r.book; if (r.event) await this.emit(r.event);
        }
      }

      // 3) Điều khiển van
      const cur = this.ctx.get(zone.zoneId) ?? initialValveCtx();
      const auto = this.d.autoIrrigation !== false;
      const prediction = auto ? await this.predict(zone, cur) : null;
      const dec = auto ? decide(zone, cur, this.irrigation, now, prediction) : { ctx: cur, command: null, note: null };
      this.ctx.set(zone.zoneId, dec.ctx);
      if (dec.command) {
        await this.d.commandStore.record(dec.command); // ghi trước khi gửi để luôn truy vết được
        await this.d.commandPublisher.publish(dec.command);
        if (dec.command.action === "close")
          this.pendingClose.set(zone.zoneId, { commandId: dec.command.commandId, since: now.getTime(), timedOut: false });
      }
      const status = dec.note ? STATUS_ON[dec.note] : undefined;
      if (status && cur.commandId) await this.d.commandStore.setStatus(cur.commandId, status, now);

      if (dec.note === "ack_timeout") {
        const r = openAlert(this.book, this.valveAlertSpec(zone, `Zone ${zone.zoneId}: van không phản hồi lệnh mở`), now, this.d.alertCooldownSec ?? 600);
        this.book = r.book; if (r.event) await this.emit(r.event);
      } else if (dec.note === "watering_started") {
        const r = closeAlert(this.book, this.valveAlertSpec(zone, `Zone ${zone.zoneId}: van đã phản hồi`), now);
        this.book = r.book; if (r.event) await this.emit(r.event);
      }
    }
  }

  /** Hỏi analytics khi luật dự đoán có thể đổi quyết định. Lỗi không làm hỏng tick: coi như không có dự đoán. */
  private async predict(zone: ZoneState, ctx: ValveCtx): Promise<Prediction | null> {
    if (!this.d.forecast || !needsPrediction(zone, ctx)) return null;
    try {
      const p = await this.d.forecast.predict(zone, this.d.predictHours ?? 1);
      this.d.onPrediction?.(p ? "ok" : "none");
      return p;
    } catch {
      this.d.onPrediction?.("error");
      return null;
    }
  }

  valvePhase(zoneId: string) { return this.ctx.get(zoneId)?.phase ?? "idle"; }
}
