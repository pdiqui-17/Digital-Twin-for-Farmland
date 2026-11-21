import type { TwinAlertEvent, ValveCommandMessage } from "@digital-twin/shared";
import type { OpenAlertRow } from "../domain/alerts";
import type { CommandRecord, CommandStatus } from "../domain/valve";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, Notifier } from "./ports";

export class MemoryCommandStore implements CommandStore, CommandPublisher {
  commands: ValveCommandMessage[] = [];
  published: ValveCommandMessage[] = [];
  status = new Map<string, CommandStatus>();
  async record(c: ValveCommandMessage) { this.commands.push(c); this.status.set(c.commandId, "sent"); }
  async publish(c: ValveCommandMessage) { this.published.push(c); }
  async setStatus(commandId: string, s: CommandStatus) { if (this.status.has(commandId)) this.status.set(commandId, s); }
  async latestPerZone(): Promise<CommandRecord[]> {
    const last = new Map<string, ValveCommandMessage>();
    for (const c of this.commands) {
      const prev = last.get(c.zoneId);
      if (!prev || Date.parse(c.ts) >= Date.parse(prev.ts)) last.set(c.zoneId, c);
    }
    return [...last.values()].map((cmd) => ({ cmd, status: this.status.get(cmd.commandId) ?? "sent" }));
  }
}

export class MemoryAlertStore implements AlertStore, AlertPublisher, Notifier {
  rows = new Map<string, TwinAlertEvent>();
  history: TwinAlertEvent[] = [];
  async upsert(e: TwinAlertEvent) {
    const prev = this.rows.get(e.alertId);
    // Giống bảng alerts: dòng giữ nội dung lúc mở, sự kiện closed chỉ đánh dấu đã đóng.
    this.rows.set(e.alertId, prev && e.state === "closed" ? { ...prev, state: "closed" } : e);
    this.history.push(e);
  }
  async loadOpen(): Promise<OpenAlertRow[]> {
    return [...this.rows.values()].filter((e) => e.state === "open").map((e) => ({ alertId: e.alertId, zoneId: e.zoneId, rule: e.rule, ts: e.ts }));
  }
  async publish() {}
  async notify() {}
}
