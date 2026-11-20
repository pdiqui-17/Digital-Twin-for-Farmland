import { DEFAULT_THRESHOLDS, type AlertEvent, type Thresholds } from "@farm/shared";
import { closeAlert, defaultRules, emptyBook, evaluateAlerts, openAlert, type AlertBook, type AlertRule } from "./domain/alerts";
import { DEFAULT_IRRIGATION, decide, initialValveCtx, type IrrigationRules, type ValveCtx } from "./domain/valve";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, Notifier, TwinSource } from "./adapters/ports";

export interface ControllerDeps {
  twin: TwinSource;
  commandPublisher: CommandPublisher;
  commandStore: CommandStore;
  alertStore: AlertStore;
  alertPublisher: AlertPublisher;
  notifier: Notifier;
  irrigation?: IrrigationRules;
  alertRules?: AlertRule[];
  thresholds?: Thresholds;
  alertCooldownSec?: number;
  /** Tắt tự động tưới (chỉ cảnh báo). */
  autoIrrigation?: boolean;
}

/** Vòng điều khiển: mỗi tick đọc twin, quyết định lệnh van và đánh giá cảnh báo. */
export class Controller {
  private ctx = new Map<string, ValveCtx>();
  private book: AlertBook = emptyBook();
  private rules: AlertRule[];
  private irrigation: IrrigationRules;

  constructor(private d: ControllerDeps) {
    this.rules = d.alertRules ?? defaultRules(d.thresholds ?? DEFAULT_THRESHOLDS);
    this.irrigation = d.irrigation ?? DEFAULT_IRRIGATION;
  }

  private async emit(e: AlertEvent) {
    await this.d.alertStore.upsert(e);
    await this.d.alertPublisher.publish(e);
    await this.d.notifier.notify(e);
  }

  async tick(now: Date = new Date()): Promise<void> {
    const zones = await this.d.twin.zones();
    for (const zone of zones) {
      // 1) Cảnh báo theo luật
      const ev = evaluateAlerts(this.book, zone, this.rules, now, this.d.alertCooldownSec);
      this.book = ev.book;
      for (const e of ev.events) await this.emit(e);

      // 2) Điều khiển van
      const cur = this.ctx.get(zone.zoneId) ?? initialValveCtx();
      const dec = this.d.autoIrrigation === false ? { ctx: cur, command: null, note: null } : decide(zone, cur, this.irrigation, now);
      this.ctx.set(zone.zoneId, dec.ctx);
      if (dec.command) {
        await this.d.commandStore.record(dec.command);   // ghi trước khi gửi để luôn truy vết được
        await this.d.commandPublisher.publish(dec.command);
      }
      if (dec.note === "ack_timeout") {
        const r = openAlert(this.book, zone.zoneId, "valve_ack_timeout", "warning",
          `Zone ${zone.zoneId}: van không phản hồi lệnh mở`, null, now, this.d.alertCooldownSec ?? 600);
        this.book = r.book; if (r.event) await this.emit(r.event);
      } else if (dec.note === "watering_started") {
        const r = closeAlert(this.book, zone.zoneId, "valve_ack_timeout", "warning", `Zone ${zone.zoneId}: van đã phản hồi`, null, now);
        this.book = r.book; if (r.event) await this.emit(r.event);
      }
    }
  }

  valvePhase(zoneId: string) { return this.ctx.get(zoneId)?.phase ?? "idle"; }
}
