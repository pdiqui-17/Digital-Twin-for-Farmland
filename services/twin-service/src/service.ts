import { EventEmitter } from "node:events";
import { DEFAULT_THRESHOLDS, type Reading, type Thresholds, type ValveStateMsg, type ZoneState } from "@farm/shared";
import { applyReading, applyValveState, initZone, refresh, type DropReason } from "./domain/twin";
import type { TwinRepository } from "./repositories/types";

export interface TwinServiceOptions {
  defaultFarmId: string;
  thresholds?: Thresholds;
  /** Xuất ra mỗi khi trạng thái zone đổi (để Controller/metrics/SSE theo dõi). */
  onDrop?: (reason: DropReason) => void;
  onApplied?: (r: Reading) => void;
}

export class TwinService extends EventEmitter {
  private th: Thresholds;
  // Tuần tự hóa theo zone để hai reading đồng thời không ghi đè nhau.
  private chains = new Map<string, Promise<unknown>>();

  constructor(private repo: TwinRepository, private opts: TwinServiceOptions) {
    super();
    this.th = opts.thresholds ?? DEFAULT_THRESHOLDS;
  }

  get thresholds() { return this.th; }

  private serial<T>(zoneId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(zoneId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(zoneId, next.catch(() => undefined));
    return next;
  }

  ingest(r: Reading, now: Date = new Date()): Promise<{ applied: boolean; reason?: DropReason }> {
    return this.serial(r.zoneId, async () => {
      const cur = (await this.repo.get(r.zoneId)) ?? initZone(r.zoneId, r.farmId ?? this.opts.defaultFarmId, now);
      const res = applyReading(cur, r, now, this.th);
      if (res.applied) this.opts.onApplied?.(r); else if (res.reason) this.opts.onDrop?.(res.reason);
      // Sensor bad vẫn làm đổi snapshot nên vẫn lưu.
      if (res.applied || res.reason === "bad_quality") {
        await this.repo.upsert(res.state);
        this.emit("update", res.state);
      }
      return { applied: res.applied, reason: res.reason };
    });
  }

  ingestValveState(msg: ValveStateMsg, now: Date = new Date()): Promise<void> {
    return this.serial(msg.zoneId, async () => {
      const cur = (await this.repo.get(msg.zoneId)) ?? initZone(msg.zoneId, this.opts.defaultFarmId, now);
      const next = applyValveState(cur, msg);
      if (next !== cur) { await this.repo.upsert(next); this.emit("update", next); }
    });
  }

  /** Gọi định kỳ: zone nào đổi status do hết dữ liệu thì cập nhật và phát sự kiện. */
  async sweepStale(now: Date = new Date()): Promise<ZoneState[]> {
    const changed: ZoneState[] = [];
    for (const z of await this.repo.list()) {
      await this.serial(z.zoneId, async () => {
        const cur = (await this.repo.get(z.zoneId)) ?? z;
        const next = refresh(cur, now, this.th);
        if (next.status !== cur.status) {
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
