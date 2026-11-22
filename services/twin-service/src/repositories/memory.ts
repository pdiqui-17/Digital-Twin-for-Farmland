import type { ZoneState } from "@digital-twin/shared";
import type { TwinReading } from "../domain/twin";
import type { HistoryPoint, HistoryQuery, TwinRepository, WritableHistory } from "./types";

export class InMemoryTwinRepository implements TwinRepository {
  private map = new Map<string, ZoneState>();
  async get(zoneId: string) { return this.map.get(zoneId) ?? null; }
  async list() { return [...this.map.values()].sort((a, b) => a.zoneId.localeCompare(b.zoneId)); }
  async upsert(state: ZoneState) { this.map.set(state.zoneId, state); }
}

export class InMemoryHistory implements WritableHistory {
  private rows: TwinReading[] = [];
  append(r: TwinReading) { this.rows.push(r); }
  async query(q: HistoryQuery): Promise<HistoryPoint[]> {
    const from = q.from ? Date.parse(q.from) : -Infinity;
    const to = q.to ? Date.parse(q.to) : Infinity;
    return this.rows
      .filter((r) => r.zoneId === q.zoneId && r.type === q.type)
      .filter((r) => Date.parse(r.ts) >= from && Date.parse(r.ts) <= to)
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
      .slice(-q.limit)
      .map((r) => ({ ts: r.ts, sensorId: r.sensorId, value: r.value, quality: r.quality }));
  }
}
