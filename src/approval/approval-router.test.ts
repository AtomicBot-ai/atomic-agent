import { describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "./approval-gate.js";
import { ApprovalRouter } from "./approval-router.js";

function req(sessionId: string, approvalId = "a1"): ApprovalRequest {
  return {
    approvalId,
    sessionId,
    tool: "os.shell.run",
    reason: "test",
  };
}

describe("ApprovalRouter", () => {
  it("routes to the per-session handler when one is registered", () => {
    const fallback = vi.fn();
    const sessionHandler = vi.fn();
    const router = new ApprovalRouter(fallback);
    router.setForSession("s-1", sessionHandler);

    router.emit(req("s-1"));

    expect(sessionHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back when no per-session handler is registered", () => {
    const fallback = vi.fn();
    const router = new ApprovalRouter(fallback);

    router.emit(req("s-other"));

    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("isolates registrations across sessions", () => {
    const fallback = vi.fn();
    const sessionA = vi.fn();
    const router = new ApprovalRouter(fallback);
    router.setForSession("s-A", sessionA);

    router.emit(req("s-A"));
    router.emit(req("s-B"));

    expect(sessionA).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes the handler", () => {
    const fallback = vi.fn();
    const handler = vi.fn();
    const router = new ApprovalRouter(fallback);
    const unsubscribe = router.setForSession("s-1", handler);

    unsubscribe();
    router.emit(req("s-1"));

    expect(handler).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(router.routedSessions()).toEqual([]);
  });

  it("a second setForSession replaces the first; the first unsubscribe is a no-op", () => {
    const fallback = vi.fn();
    const first = vi.fn();
    const second = vi.fn();
    const router = new ApprovalRouter(fallback);
    const unsubscribeFirst = router.setForSession("s-1", first);
    router.setForSession("s-1", second);

    // The stale unsubscribe must not delete the live registration.
    unsubscribeFirst();

    router.emit(req("s-1"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("routedSessions reports a snapshot of registered ids", () => {
    const fallback = vi.fn();
    const router = new ApprovalRouter(fallback);
    router.setForSession("s-1", vi.fn());
    router.setForSession("s-2", vi.fn());

    expect(new Set(router.routedSessions())).toEqual(new Set(["s-1", "s-2"]));
  });
});
