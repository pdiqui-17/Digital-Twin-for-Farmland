import type { AlertEvent } from "@farm/shared";
import type { Notifier } from "./ports";

export class ConsoleNotifier implements Notifier {
  async notify(e: AlertEvent) { console.log(`[ALERT ${e.severity} ${e.state}] ${e.message}`); }
}

/** Gửi qua Telegram Bot API. Lỗi mạng không được làm hỏng vòng điều khiển. */
export class TelegramNotifier implements Notifier {
  constructor(private token: string, private chatId: string, private fetchFn: typeof fetch = fetch) {}
  async notify(e: AlertEvent) {
    const icon = e.state === "closed" ? "✅" : e.severity === "critical" ? "🚨" : "⚠️";
    try {
      await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text: `${icon} ${e.message}` }),
      });
    } catch { /* bỏ qua */ }
  }
}
