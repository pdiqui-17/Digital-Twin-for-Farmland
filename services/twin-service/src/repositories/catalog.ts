import type { Pool } from "pg";
import { deriveThresholds, type Thresholds } from "@digital-twin/shared";

export interface ZoneInfo {
  zoneId: string;
  farmId: string;
  thresholds: Thresholds;
}

/** Danh mục zone (bảng zones do seed của Role A ghi). Twin chỉ đọc. */
export interface ZoneCatalog {
  get(zoneId: string): ZoneInfo | undefined;
  list(): ZoneInfo[];
}

export class StaticZoneCatalog implements ZoneCatalog {
  private map: Map<string, ZoneInfo>;
  constructor(zones: ZoneInfo[]) { this.map = new Map(zones.map((z) => [z.zoneId, z])); }
  get(zoneId: string) { return this.map.get(zoneId); }
  list() { return [...this.map.values()]; }
}

export async function loadPgZoneCatalog(pool: Pool, staleAfterSec: number): Promise<StaticZoneCatalog> {
  const r = await pool.query(
    "SELECT id, farm_id, moisture_optimal_min, moisture_optimal_max FROM zones ORDER BY id",
  );
  return new StaticZoneCatalog(
    r.rows.map((x) => ({
      zoneId: x.id as string,
      farmId: x.farm_id as string,
      thresholds: deriveThresholds(Number(x.moisture_optimal_min), Number(x.moisture_optimal_max), staleAfterSec),
    })),
  );
}
