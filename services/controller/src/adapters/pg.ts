import type { Pool } from "pg";
import type { AlertEvent, Command } from "@farm/shared";
import type { AlertStore, CommandStore } from "./ports";

/** Bảng commands(command_id PK, zone_id, action, duration_sec, reason, ts) - db/migrations/010_twin.sql. */
export class PgCommandStore implements CommandStore {
  constructor(private pool: Pool) {}
  async record(c: Command) {
    await this.pool.query(
      `INSERT INTO commands (command_id, zone_id, action, duration_sec, reason, ts) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (command_id) DO NOTHING`,
      [c.commandId, c.zoneId, c.action, c.durationSec ?? null, c.reason, c.ts],
    );
  }
}

/** Bảng alerts(alert_id PK, ...): một dòng cho mỗi vòng đời; sự kiện closed cập nhật dòng đã mở. */
export class PgAlertStore implements AlertStore {
  constructor(private pool: Pool) {}
  async upsert(e: AlertEvent) {
    if (e.state === "open") {
      await this.pool.query(
        `INSERT INTO alerts (alert_id, zone_id, rule, severity, message, value, opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (alert_id) DO NOTHING`,
        [e.alertId, e.zoneId, e.rule, e.severity, e.message, e.value, e.ts],
      );
    } else {
      await this.pool.query(`UPDATE alerts SET closed_at = $2 WHERE alert_id = $1`, [e.alertId, e.ts]);
    }
  }
}
