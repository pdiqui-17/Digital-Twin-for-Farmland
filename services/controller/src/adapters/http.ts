import type { ZoneState } from "@farm/shared";
import type { TwinSource } from "./ports";

export class HttpTwinSource implements TwinSource {
  constructor(private baseUrl: string, private fetchFn: typeof fetch = fetch) {}
  async zones(): Promise<ZoneState[]> {
    const res = await this.fetchFn(`${this.baseUrl}/zones`);
    if (!res.ok) throw new Error(`twin-service ${res.status}`);
    return (await res.json()) as ZoneState[];
  }
}
