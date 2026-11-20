import type { AlertEvent, Command, ZoneState } from "@farm/shared";

export interface TwinSource { zones(): Promise<ZoneState[]>; }
export interface CommandPublisher { publish(cmd: Command): Promise<void>; }
export interface CommandStore { record(cmd: Command): Promise<void>; }
export interface AlertStore { upsert(e: AlertEvent): Promise<void>; }
export interface AlertPublisher { publish(e: AlertEvent): Promise<void>; }
export interface Notifier { notify(e: AlertEvent): Promise<void>; }
