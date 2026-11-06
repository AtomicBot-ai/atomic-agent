import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import { ApprovalBus, MAX_MIRRORED_APPROVALS } from "./approval-bus.js";

const request = (n: number): ApprovalRequest =>
  ({ approvalId: `a${n}`, sessionId: "s", tool: "shell", category: "shell", reason: "r" }) as ApprovalRequest;

describe("ApprovalBus pending mirror (ATO-1111)", () => {
  it("never keeps more than the cap, dropping the oldest first", () => {
    const bus = new ApprovalBus();
    for (let i = 0; i < MAX_MIRRORED_APPROVALS + 25; i++) bus.publish(request(i));
    const ids = bus.snapshot().map((r) => r.approvalId);
    expect(ids).toHaveLength(MAX_MIRRORED_APPROVALS);
    expect(ids[0]).toBe("a25");
    expect(ids.at(-1)).toBe(`a${MAX_MIRRORED_APPROVALS + 24}`);
  });

  it("prune drops what the gate no longer holds", () => {
    const bus = new ApprovalBus();
    bus.publish(request(1));
    bus.publish(request(2));
    bus.prune((r) => r.approvalId === "a2");
    expect(bus.snapshot().map((r) => r.approvalId)).toEqual(["a2"]);
  });

  it("resolved removes one request", () => {
    const bus = new ApprovalBus();
    bus.publish(request(1));
    bus.resolved("a1");
    expect(bus.snapshot()).toEqual([]);
  });
});
