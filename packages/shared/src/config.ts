/** Ngưỡng nghiệp vụ dùng chung giữa Twin Service, Controller và Analytics. */
export interface Thresholds {
  /** Điểm héo (%VWC): dưới mức này cây bị stress hoàn toàn. */
  wiltingPoint: number;
  /** Dưới mức này bắt đầu có stress nước. */
  optimalLow: number;
  /** Sức chứa ruộng: trên mức này nước thoát đi. */
  fieldCapacity: number;
  /** status = dry khi độ ẩm < dryBelow. */
  dryBelow: number;
  /** status = critical khi độ ẩm < criticalBelow. */
  criticalBelow: number;
  /** Thời gian không có dữ liệu thì zone chuyển unknown (giây). */
  staleAfterSec: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  wiltingPoint: 18,
  optimalLow: 30,
  fieldCapacity: 40,
  dryBelow: 28,
  criticalBelow: 22,
  staleAfterSec: 300,
};

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
