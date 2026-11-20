import type { Pool } from "pg";
import type { ZoneState } from "@farm/shared";
import type { HistoryPoint, HistoryQuery, HistoryRepository, TwinRepository } from "./types";

/** Bảng twin_state(zone_id PK, farm_id, state JSONB, updated_at) - xem db/migrations/010_twin.sql. */
export class PgTwinRepository implements TwinRepository {
  constructor(private pool: Pool) {}
  async get(zoneId: string) {
    const r = await this.pool.query("SELECT state FROM twin_state WHERE zone_id = $1", [zoneId]);
    return (r.rows[0]?.state as ZoneState) ?? null;
  }
  async list() {
    const r = await this.pool.query("SELECT state FROM twin_state ORDER BY zone_id");
    return r.rows.map((x) => x.state as ZoneState);
  }
  async upsert(s: ZoneState) {
    await this.pool.query(
      `INSERT INTO twin_state (zone_id, farm_id, state, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (zone_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [s.zoneId, s.farmId, JSON.stringify(s), s.updatedAt],
    );
  }
}

/** Đọc sensor_readings(ts, sensor_id, zone_id, type, value, quality) do Processor ghi. */
export class PgHistory implements HistoryRepository {
  constructor(private pool: Pool) {}
  async query(q: HistoryQuery): Promise<HistoryPoint[]> {
    const r = await this.pool.query(
      `SELECT ts, sensor_id, value FROM sensor_readings
       WHERE zone_id = $1 AND type = $2 AND ts >= COALESCE($3::timestamptz, '-infinity') AND ts <= COALESCE($4::timestamptz, 'infinity')
       ORDER BY ts DESC LIMIT $5`,
      [q.zoneId, q.type, q.from ?? null, q.to ?? null, q.limit],
    );
    return r.rows
      .map((x) => ({ ts: new Date(x.ts).toISOString(), sensorId: x.sensor_id as string, value: Number(x.value) }))
      .reverse();
  }
}
