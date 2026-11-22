import { EventEmitter } from "node:events";
import { DEFAULT_THRESHOLDS, type Thresholds, type ZoneState } from "@digital-twin/shared";
import { applyReading, applyValveState, initZone, refresh, withThresholds, type DropReason, type TwinReading, type ValveUpdate } from "./domain/twin";
import type { ZoneCatalog } from "./repositories/catalog";
import type { TwinRepository } from "./repositories/types";

export interface TwinServiceOptions {
  defaultFarmId: string;
  /** Danh mục zone: ngưỡng theo zone. Có catalog thì zone ngoài danh mục bị bỏ (twin_state có FK tới zones). */
  catalog?: ZoneCatalog;
  /** Ngưỡng khi không có catalog. */
  defaultThresholds?: Thresholds;
  /** Tỉ lệ thời gian mô phỏng (simTimeScale), mặc định 1 = thời gian thật. */
  timeScale?: number;
  onDrop?: (reason: DropReason) => void;
  onApplied?: (r: TwinReading) => void;
}

/** Phát sự kiện "update" (ZoneState) mỗi khi trạng thái zone đổi, để SSE/metrics theo dõi. */
export class TwinService extends EventEmitter {
  // Tuần tự hóa theo zone để hai reading đồng thời không ghi đè nhau.
  private chains = new Map<string, Promise<unknown>>();

  constructor(private repo: TwinRepository, private opts: TwinServiceOptions) {
    super();
  }

  private serial<T>(zoneId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(zoneId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(zoneId, next.catch(() => undefined));
    return next;
  }

  /** Đọc zone hiện tại hoặc tạo mới; luôn áp ngưỡng mới nhất của danh mục. null nếu zone không có trong danh mục. */
  private async load(zoneId: string, farmId: string | undefined, now: Date): Promise<ZoneState | null> {
    const info = this.opts.catalog?.get(zoneId);
    if (this.opts.catalog && !info) return null;
    const th = info?.thresholds ?? this.opts.defaultThresholds ?? DEFAULT_THRESHOLDS;
    const cur = await this.repo.get(zoneId);
    if (!cur) return initZone(zoneId, info?.farmId ?? farmId ?? this.opts.defaultFarmId, now, th);
    return info && JSON.stringify(cur.thresholds) !== JSON.stringify(th) ? withThresholds(cur, th, now) : cur;
  }

  ingest(r: TwinReading, now: Date = new Date()): Promise<{ applied: boolean; reason?: DropReason }> {
    return this.serial(r.zoneId, async () => {
      const cur = await this.load(r.zoneId, r.farmId, now);
      if (!cur) {
        this.opts.onDrop?.("unknown_zone");
        return { applied: false, reason: "unknown_zone" as const };
      }
      const res = applyReading(cur, r, now, this.opts.timeScale ?? 1);
      if (res.applied) this.opts.onApplied?.(r);
      else if (res.reason) this.opts.onDrop?.(res.reason);
      // Bản tin lỗi cảm biến vẫn đổi snapshot/faultySensors nên vẫn lưu.
      if (res.applied || res.reason === "sensor_fault") {
        await this.repo.upsert(res.state);
        this.emit("update", res.state);
      }
      return { applied: res.applied, reason: res.reason };
    });
  }

  ingestValveState(zoneId: string, msg: ValveUpdate, farmId?: string, now: Date = new Date()): Promise<void> {
    return this.serial(zoneId, async () => {
      const cur = await this.load(zoneId, farmId, now);
      if (!cur) return;
      const next = applyValveState(cur, msg);
      if (next !== cur) {
        await this.repo.upsert(next);
        this.emit("update", next);
      }
    });
  }

  /** Gọi định kỳ: zone nào đổi status hoặc danh sách sensor lỗi do hết hạn dữ liệu thì cập nhật và phát sự kiện. */
  async sweepStale(now: Date = new Date()): Promise<ZoneState[]> {
    const changed: ZoneState[] = [];
    for (const z of await this.repo.list()) {
      await this.serial(z.zoneId, async () => {
        const cur = (await this.repo.get(z.zoneId)) ?? z;
        const next = refresh(cur, now);
        if (next.status !== cur.status || next.faultySensors.join() !== cur.faultySensors.join()) {
          await this.repo.upsert(next);
          this.emit("update", next);
          changed.push(next);
        }
      });
    }
    return changed;
  }

  getZone(zoneId: string) { return this.repo.get(zoneId); }
  listZones() { return this.repo.list(); }
}
