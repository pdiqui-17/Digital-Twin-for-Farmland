import type { DataQuality, SensorType, ZoneState } from "@digital-twin/shared";
import type { TwinReading } from "../domain/twin";

export interface TwinRepository {
  get(zoneId: string): Promise<ZoneState | null>;
  list(): Promise<ZoneState[]>;
  upsert(state: ZoneState): Promise<void>;
}

export interface HistoryQuery {
  zoneId: string;
  type: SensorType;
  from?: string;
  to?: string;
  limit: number;
}

export interface HistoryPoint {
  ts: string;
  sensorId: string;
  value: number;
  quality: DataQuality;
}

/** Chỉ đọc: bảng sensor_readings do Processor (role A) ghi. */
export interface HistoryRepository {
  query(q: HistoryQuery): Promise<HistoryPoint[]>;
}

/** Chỉ dùng cho test/fake-feed: nhận reading để phục vụ truy vấn lịch sử. */
export interface WritableHistory extends HistoryRepository {
  append(r: TwinReading): void;
}
