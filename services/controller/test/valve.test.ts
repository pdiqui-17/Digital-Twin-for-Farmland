import { describe, it, expect } from "vitest";
import { ValveCommandMessageSchema } from "@digital-twin/shared";
import { DEFAULT_IRRIGATION as R, closeAck, toRealSeconds, decide, initialValveCtx, restorePendingClose, restoreValveCtx, stopAt, type PendingClose, type ValveCtx } from "../src/domain/valve";
import { at, zone } from "./helpers";

const pending = (since = 0): ValveCtx => ({ phase: "pending", since: at(since).getTime(), commandId: "c1" });
const watering = (since = 0): ValveCtx => ({ phase: "watering", since: at(since).getTime(), commandId: "c1" });
const cooldown = (since = 0): ValveCtx => ({ phase: "cooldown", since: at(since).getTime() });

describe("valve idle", () => {
  it("độ ẩm dưới ngưỡng của zone thì gửi lệnh mở hợp lệ theo hợp đồng của Role A", () => {
    const d = decide(zone({ moisture: 42 }), initialValveCtx(), R, at(1));
    expect(d.command).toMatchObject({
      action: "open", farmId: "farm-01", zoneId: "zone-A", actuatorId: "valve-zone-A", issuedBy: "controller", durationSec: R.maxRunSec,
    });
    expect(d.command!.reason).toContain("42.0");
    expect(ValveCommandMessageSchema.safeParse(d.command).success).toBe(true);
    expect(d.ctx.phase).toBe("pending");
  });
  it("không mở khi độ ẩm chưa tới ngưỡng, khi thiếu dữ liệu, khi van đã mở", () => {
    expect(decide(zone({ moisture: 46 }), initialValveCtx(), R, at(1)).command).toBeNull();
    expect(decide(zone({ moisture: null }), initialValveCtx(), R, at(1)).command).toBeNull();
    expect(decide(zone({ moisture: 40, valve: "open" }), initialValveCtx(), R, at(1)).command).toBeNull();
  });
});

describe("valve pending", () => {
  it("van báo open với lastCommandId khớp thì chuyển watering", () => {
    const d = decide(zone({ moisture: 42, valve: "open", valveTs: at(0), lastCommandId: "c1" }), pending(1), R, at(1));
    expect(d.ctx.phase).toBe("watering");
    expect(d.note).toBe("watering_started");
  });
  it("lastCommandId của lệnh khác không được tính, dù ts mới hơn", () => {
    const t = new Date(at(1).getTime() + 10_000); // còn trong ackTimeout
    const d = decide(zone({ moisture: 42, valve: "open", valveTs: t, lastCommandId: "other" }), pending(1), R, t);
    expect(d.ctx.phase).toBe("pending");
  });
  it("nguồn không gửi lastCommandId thì so thời điểm: ack cũ không được tính", () => {
    expect(decide(zone({ moisture: 42, valve: "open", valveTs: at(0) }), pending(5), R, at(5)).ctx.phase).toBe("pending");
    expect(decide(zone({ moisture: 42, valve: "open", valveTs: at(5) }), pending(5), R, at(5)).ctx.phase).toBe("watering");
  });
  it("quá ackTimeout thì vào cooldown, báo ack_timeout và gửi lệnh đóng để an toàn", () => {
    const d = decide(zone({ moisture: 42 }), pending(0), R, new Date(at(0).getTime() + 31_000));
    expect(d.ctx.phase).toBe("cooldown");
    expect(d.note).toBe("ack_timeout");
    expect(d.command?.action).toBe("close");
  });
});

describe("valve watering", () => {
  it("mục tiêu là giữa khoảng tối ưu của zone", () => expect(stopAt(zone(), R)).toBe(57.5));
  it("đạt mục tiêu thì đóng van", () => {
    const d = decide(zone({ moisture: 58, valve: "open" }), watering(0), R, at(10));
    expect(d.command).toMatchObject({ action: "close", actuatorId: "valve-zone-A" });
    expect(d.note).toBe("target_reached");
    expect(d.ctx.phase).toBe("cooldown");
  });
  it("quá maxRun thì đóng dù chưa đạt mục tiêu", () => {
    const d = decide(zone({ moisture: 50, valve: "open" }), watering(0), R, at(31));
    expect(d.note).toBe("max_run");
    expect(d.command?.action).toBe("close");
  });
  it("mất dữ liệu khi đang tưới thì đóng van an toàn", () => {
    const d = decide(zone({ moisture: null, valve: "open" }), watering(0), R, at(5));
    expect(d.note).toBe("data_lost");
    expect(d.command?.action).toBe("close");
  });
  it("đang tưới bình thường thì giữ nguyên", () => {
    const d = decide(zone({ moisture: 50, valve: "open" }), watering(0), R, at(5));
    expect(d.command).toBeNull();
    expect(d.ctx.phase).toBe("watering");
  });
  it("van bị đóng từ bên ngoài (simulator tự đóng sau durationSec) thì về cooldown, không gửi lệnh", () => {
    const d = decide(zone({ moisture: 50, valve: "closed", valveTs: at(3) }), watering(0), R, at(5));
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

const cmd = (action: "open" | "close", min: number) => ({
  commandId: "c1", farmId: "farm-01", zoneId: "zone-A", action, issuedBy: "controller", ts: at(min).toISOString(),
});

describe("restoreValveCtx (sau khi controller khởi động lại)", () => {
  it("không có lệnh nào thì idle", () => expect(restoreValveCtx(undefined, R, at(0)).phase).toBe("idle"));
  it("lệnh open đã xác nhận, chưa quá maxRun thì tiếp tục watering", () => {
    expect(restoreValveCtx({ cmd: cmd("open", 0), status: "acknowledged" }, R, at(10))).toMatchObject({ phase: "watering", commandId: "c1" });
  });
  it("lệnh open chưa xác nhận, còn trong ackTimeout thì pending", () => {
    expect(restoreValveCtx({ cmd: cmd("open", 0), status: "sent" }, R, new Date(at(0).getTime() + 10_000)).phase).toBe("pending");
  });
  it("vừa tưới xong trong thời gian nghỉ thì cooldown (không tưới lại ngay sau restart)", () => {
    expect(restoreValveCtx({ cmd: cmd("close", 0), status: "sent" }, R, at(30)).phase).toBe("cooldown");
    expect(restoreValveCtx({ cmd: cmd("open", 0), status: "completed" }, R, at(30)).phase).toBe("cooldown");
  });
  it("lệnh cũ hơn thời gian nghỉ thì idle", () => {
    expect(restoreValveCtx({ cmd: cmd("close", 0), status: "sent" }, R, at(61)).phase).toBe("idle");
  });
});

describe("closeAck (theo dõi lệnh close)", () => {
  const pc = (since = 0, timedOut = false): PendingClose => ({ commandId: "c-close", since: at(since).getTime(), timedOut });
  it("van báo closed đúng commandId thì confirmed", () => {
    expect(closeAck(zone({ valve: "closed", valveTs: at(0), lastCommandId: "c-close" }), pc(), R, at(0))).toBe("confirmed");
  });
  it("closed nhưng commandId của lệnh khác (vd. van tự đóng theo durationSec) thì chưa confirmed", () => {
    expect(closeAck(zone({ valve: "closed", valveTs: at(0), lastCommandId: "c-open" }), pc(), R, at(0))).toBeNull();
  });
  it("nguồn không gửi commandId: dựa vào ts mới hơn lệnh", () => {
    expect(closeAck(zone({ valve: "closed", valveTs: at(1) }), pc(0), R, at(1))).toBe("confirmed");
    expect(closeAck(zone({ valve: "closed", valveTs: at(-1) }), pc(0), R, at(0))).toBeNull();
  });
  it("quá ackTimeoutSec thì timeout đúng MỘT lần, xác nhận muộn vẫn được ghi nhận", () => {
    const stillOpen = zone({ valve: "open", valveTs: at(0), lastCommandId: "c-open" });
    expect(closeAck(stillOpen, pc(0), R, at(1))).toBe("timeout");
    expect(closeAck(stillOpen, pc(0, true), R, at(2))).toBeNull();
    expect(closeAck(zone({ valve: "closed", valveTs: at(3), lastCommandId: "c-close" }), pc(0, true), R, at(3))).toBe("confirmed");
  });
  it("restorePendingClose: chỉ khôi phục khi lệnh gần nhất là close còn sent", () => {
    expect(restorePendingClose({ cmd: cmd("close", 0), status: "sent" })).toMatchObject({ commandId: "c1", timedOut: false });
    expect(restorePendingClose({ cmd: cmd("close", 0), status: "completed" })).toBeUndefined();
    expect(restorePendingClose({ cmd: cmd("open", 0), status: "sent" })).toBeUndefined();
  });
});

describe("toRealSeconds (mốc giây ruộng -> giây thật)", () => {
  it("chia theo tốc độ mô phỏng, làm tròn", () => {
    expect(toRealSeconds(3600, 1)).toBe(3600);  // nông trại thật
    expect(toRealSeconds(3600, 60)).toBe(60);   // simulator mặc định
    expect(toRealSeconds(1800, 300)).toBe(6);   // tick 1 s
    expect(toRealSeconds(600, 7)).toBe(86);
  });
  it("tối thiểu 1 s (durationSec phải là số nguyên dương)", () => {
    expect(toRealSeconds(30, 300)).toBe(1);
  });
});
