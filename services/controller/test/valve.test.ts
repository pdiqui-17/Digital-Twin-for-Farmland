import { describe, it, expect } from "vitest";
import { DEFAULT_IRRIGATION as R, decide, initialValveCtx, type ValveCtx } from "../src/domain/valve";
import { at, zone } from "./helpers";

const pending = (since = 0): ValveCtx => ({ phase: "pending", since: at(since).getTime(), commandId: "c1" });
const watering = (since = 0): ValveCtx => ({ phase: "watering", since: at(since).getTime(), commandId: "c1" });
const cooldown = (since = 0): ValveCtx => ({ phase: "cooldown", since: at(since).getTime() });

describe("valve idle", () => {
  it("độ ẩm dưới ngưỡng thì gửi lệnh mở kèm lý do và duration", () => {
    const d = decide(zone({ moisture: 25 }), initialValveCtx(), R, at(1));
    expect(d.command).toMatchObject({ action: "open", zoneId: "zone-A", durationSec: R.maxRunSec });
    expect(d.command!.reason).toContain("25.0");
    expect(d.ctx.phase).toBe("pending");
  });
  it("không mở khi độ ẩm chưa tới ngưỡng, khi thiếu dữ liệu, khi đang mưa, khi van đã mở", () => {
    expect(decide(zone({ moisture: 27 }), initialValveCtx(), R, at(1)).command).toBeNull();
    expect(decide(zone({ moisture: null }), initialValveCtx(), R, at(1)).command).toBeNull();
    expect(decide(zone({ moisture: 20, rain: 2 }), initialValveCtx(), R, at(1)).command).toBeNull();
    expect(decide(zone({ moisture: 20, valve: "open" }), initialValveCtx(), R, at(1)).command).toBeNull();
  });
});

describe("valve pending", () => {
  it("nhận ack (van open, ts >= lúc gửi) thì chuyển watering", () => {
    const d = decide(zone({ moisture: 25, valve: "open", valveTs: at(1) }), pending(1), R, at(1));
    expect(d.ctx.phase).toBe("watering");
    expect(d.note).toBe("watering_started");
  });
  it("ack cũ (trước lúc gửi lệnh) không được tính", () => {
    const d = decide(zone({ moisture: 25, valve: "open", valveTs: at(0) }), pending(5), R, at(5));
    expect(d.ctx.phase).toBe("pending");
  });
  it("quá ackTimeout thì vào cooldown và báo ack_timeout, không gửi lại lệnh", () => {
    const d = decide(zone({ moisture: 25 }), pending(0), R, new Date(at(0).getTime() + 31_000));
    expect(d.ctx.phase).toBe("cooldown");
    expect(d.note).toBe("ack_timeout");
    expect(d.command).toBeNull();
  });
});

describe("valve watering", () => {
  it("đạt stopAt thì đóng van", () => {
    const d = decide(zone({ moisture: 34, valve: "open" }), watering(0), R, at(10));
    expect(d.command).toMatchObject({ action: "close" });
    expect(d.note).toBe("target_reached");
    expect(d.ctx.phase).toBe("cooldown");
  });
  it("quá maxRun thì đóng dù chưa đạt mục tiêu", () => {
    const d = decide(zone({ moisture: 30, valve: "open" }), watering(0), R, at(31));
    expect(d.note).toBe("max_run");
    expect(d.command?.action).toBe("close");
  });
  it("mất dữ liệu khi đang tưới thì đóng van an toàn", () => {
    const d = decide(zone({ moisture: null, valve: "open" }), watering(0), R, at(5));
    expect(d.note).toBe("data_lost");
    expect(d.command?.action).toBe("close");
  });
  it("đang tưới bình thường thì giữ nguyên", () => {
    const d = decide(zone({ moisture: 30, valve: "open" }), watering(0), R, at(5));
    expect(d.command).toBeNull();
    expect(d.ctx.phase).toBe("watering");
  });
  it("van bị đóng từ bên ngoài thì về cooldown, không gửi lệnh", () => {
    const d = decide(zone({ moisture: 30, valve: "closed", valveTs: at(3) }), watering(0), R, at(5));
    expect(d.note).toBe("closed_externally");
    expect(d.command).toBeNull();
  });
});

describe("valve cooldown", () => {
  it("không tưới lại trong thời gian nghỉ dù độ ẩm rất thấp", () => {
    const d = decide(zone({ moisture: 10 }), cooldown(0), R, at(59));
    expect(d.command).toBeNull();
    expect(d.ctx.phase).toBe("cooldown");
  });
  it("hết thời gian nghỉ thì về idle, lần tick sau mới được mở", () => {
    const d = decide(zone({ moisture: 10 }), cooldown(0), R, at(60));
    expect(d.ctx.phase).toBe("idle");
    expect(d.command).toBeNull();
  });
});
