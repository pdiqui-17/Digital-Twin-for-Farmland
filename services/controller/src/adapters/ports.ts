import type { TwinAlertEvent, ValveCommandMessage, ZoneState } from "@digital-twin/shared";
import type { OpenAlertRow } from "../domain/alerts";
import type { CommandRecord, CommandStatus, Prediction } from "../domain/valve";

export interface TwinSource { zones(): Promise<ZoneState[]>; }
/** Dự đoán độ ẩm sau `hours` giờ ruộng nếu không tưới. null = không có dự đoán đáng tin (chưa calibrate). */
export interface ForecastSource { predict(zone: ZoneState, hours: number): Promise<Prediction | null>; }
export interface CommandPublisher { publish(cmd: ValveCommandMessage): Promise<void>; }

/** Bảng commands: chỉ Controller ghi. */
export interface CommandStore {
  record(cmd: ValveCommandMessage): Promise<void>;
  setStatus(commandId: string, status: CommandStatus, at: Date): Promise<void>;
  /** Lệnh gần nhất của mỗi zone, để khôi phục sau khi khởi động lại. */
  latestPerZone(): Promise<CommandRecord[]>;
}

/** Bảng alerts: chỉ Controller ghi. */
export interface AlertStore {
  upsert(e: TwinAlertEvent): Promise<void>;
  loadOpen(): Promise<OpenAlertRow[]>;
}
export interface AlertPublisher { publish(e: TwinAlertEvent): Promise<void>; }
export interface Notifier { notify(e: TwinAlertEvent): Promise<void>; }
