import type { AlertEvent, Command } from "@farm/shared";
import type { AlertPublisher, AlertStore, CommandPublisher, CommandStore, Notifier } from "./ports";

export class MemoryCommandStore implements CommandStore, CommandPublisher {
  commands: Command[] = [];
  async record(c: Command) { this.commands.push(c); }
  async publish(c: Command) { this.published.push(c); }
  published: Command[] = [];
}
export class MemoryAlertStore implements AlertStore, AlertPublisher, Notifier {
  rows = new Map<string, AlertEvent>();
  history: AlertEvent[] = [];
  async upsert(e: AlertEvent) { this.rows.set(e.alertId, e); this.history.push(e); }
  async publish() {}
  async notify() {}
}
