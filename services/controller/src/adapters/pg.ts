import type { Pool } from "pg";
import type { TwinAlertEvent, ValveCommandMessage } from "@digital-twin/shared";
import type { OpenAlertRow } from "../domain/alerts";
import type { CommandRecord, CommandStatus } from "../domain/valve";
import type { AlertStore, CommandStore } from "./ports";

/** Bảng commands (db/migrations/003). */
export class PgCommandStore implements CommandStore {
  constructor(private pool: Pool) {}

  async record(c: ValveCommandMessage) {
    await this.pool.query(
      `INSERT INTO commands (command_id, farm_id, zone_id, actuator_id, action, duration_sec, reason, issued_by, status, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', $9)
       ON CONFLICT (command_id) DO NOTHING`,
      [c.commandId, c.farmId, c.zoneId, c.actuatorId ?? null, c.action, c.durationSec ?? null, c.reason ?? null, c.issuedBy, c.ts],
    );
  }

  async setStatus(commandId: string, status: CommandStatus, at: Date) {
    await this.pool.query(
      `UPDATE commands SET status = $2,
         acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN $3::timestamptz ELSE acknowledged_at END
       WHERE command_id = $1`,
      [commandId, status, at.toISOString()],
    );
  }

  async latestPerZone(): Promise<CommandRecord[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (zone_id) command_id, farm_id, zone_id, actuator_id, action, duration_sec, reason, issued_by, status, ts
       FROM commands ORDER BY zone_id, ts DESC`,
    );
    return r.rows.map((x) => ({
      cmd: {
        commandId: x.command_id, farmId: x.farm_id, zoneId: x.zone_id, actuatorId: x.actuator_id ?? undefined,
        action: x.action, durationSec: x.duration_sec ?? undefined, reason: x.reason ?? undefined,
        issuedBy: x.issued_by, ts: new Date(x.ts).toISOString(),
      },
      status: x.status as CommandStatus,
    }));
  }
}

/**
 * Bảng alerts (db/migrations/003 + 005): một dòng cho mỗi vòng đời cảnh báo.
 * Sự kiện open chèn dòng (ts = lúc mở); sự kiện closed đặt closed_at.
 */
export class PgAlertStore implements AlertStore {
  constructor(private pool: Pool) {}

  async upsert(e: TwinAlertEvent) {
    if (e.state === "open") {
      await this.pool.query(
        `INSERT INTO alerts (alert_id, farm_id, zone_id, severity, category, message, metadata, ts, rule)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (alert_id) DO NOTHING`,
        [e.alertId, e.farmId, e.zoneId, e.severity, e.category, e.message, JSON.stringify({ value: e.value, ...e.metadata }), e.ts, e.rule],
      );
    } else {
      await this.pool.query(`UPDATE alerts SET closed_at = $2 WHERE alert_id = $1 AND closed_at IS NULL`, [e.alertId, e.ts]);
    }
  }

  async loadOpen(): Promise<OpenAlertRow[]> {
    const r = await this.pool.query(`SELECT alert_id, zone_id, rule, ts FROM alerts WHERE closed_at IS NULL AND rule IS NOT NULL`);
    return r.rows.map((x) => ({ alertId: x.alert_id, zoneId: x.zone_id, rule: x.rule, ts: new Date(x.ts).toISOString() }));
  }
}
