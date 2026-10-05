import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalRequest } from "../approval/approval-gate.js";

import { beginSse } from "./request-context.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/approval/resolve", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ approvalLevel: 1 });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("unblocks a pending approval request", async () => {
    let capturedId: string | null = null;
    harness.approvalBus.subscribe((request: ApprovalRequest) => {
      capturedId = request.approvalId;
    });

    const pending = harness.runtime.approvals.request({
      sessionId: "s-test",
      tool: "os.shell.run",
      category: "shell",
      reason: "test",
      approvalId: "approval-1",
    });
    expect(capturedId).toBe("approval-1");

    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvalId: "approval-1",
        decision: "allow-once",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resolved: boolean;
      approved: boolean;
    };
    expect(body.resolved).toBe(true);
    expect(body.approved).toBe(true);

    const decision = await pending;
    expect(decision.approved).toBe(true);
  });

  it("returns 404 when the approvalId is not pending", async () => {
    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "ghost", decision: "deny" }),
    });
    expect(response.status).toBe(404);
  });

  it("forgets a request the gate no longer holds when it is answered", async () => {
    // B01: a card of an aborted turn answered from the desktop. The 404
    // stays, and the request is no longer replayed on /api/events.
    harness.approvalBus.publish({
      approvalId: "ghost-2",
      sessionId: "s-test",
      tool: "os.shell.run",
      category: "shell",
      reason: "test",
    });
    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "ghost-2", decision: "allow-once" }),
    });
    expect(response.status).toBe(404);
    expect(harness.approvalBus.snapshot()).toEqual([]);
  });

  it("rejects unknown decision strings", async () => {
    const response = await fetch(`${harness.baseUrl}/api/approval/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalId: "x", decision: "maybe" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/events", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness({ approvalLevel: 1 });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("does not replay a request whose turn was aborted", async () => {
    // B01: the gate drops a request when its turn is aborted (the client
    // gone, Stop); the bus kept it, and every reconnect drew it again as a
    // live card for the same command.
    const live = harness.runtime.approvals.request({
      sessionId: "s-live",
      tool: "os.shell.run",
      category: "shell",
      reason: "test",
      approvalId: "approval-live",
    });
    const turn = new AbortController();
    const dead = harness.runtime.approvals.request(
      {
        sessionId: "s-dead",
        tool: "os.shell.run",
        category: "shell",
        reason: "test",
        approvalId: "approval-dead",
      },
      { signal: turn.signal },
    );
    turn.abort();
    await expect(dead).rejects.toThrow(/aborted/);
    expect(harness.approvalBus.snapshot().map((r) => r.approvalId)).toEqual([
      "approval-live",
      "approval-dead",
    ]);

    const stream = new AbortController();
    const res = await fetch(`${harness.baseUrl}/api/events`, {
      signal: stream.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("approval-live")) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    stream.abort();
    await reader.cancel().catch(() => undefined);

    expect(text).toContain("approval-live");
    expect(text).not.toContain("approval-dead");
    expect(harness.approvalBus.snapshot().map((r) => r.approvalId)).toEqual([
      "approval-live",
    ]);

    harness.runtime.approvals.resolve({
      approvalId: "approval-live",
      approved: false,
    });
    await live;
  });
});

describe("beginSse heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeResponse(): ServerResponse & { chunks: string[] } {
    const res = new EventEmitter() as EventEmitter & {
      chunks: string[];
      writableEnded: boolean;
      writeHead: () => void;
      write: (chunk: string) => boolean;
      end: () => void;
    };
    res.chunks = [];
    res.writableEnded = false;
    res.writeHead = () => undefined;
    res.write = (chunk: string) => {
      res.chunks.push(chunk);
      return true;
    };
    res.end = () => {
      res.writableEnded = true;
    };
    return res as unknown as ServerResponse & { chunks: string[] };
  }

  it("writes a comment line while the stream is quiet, and stops when it closes", () => {
    // B01: a turn parked on an approval wrote nothing for minutes, and
    // the desktop's fetch dropped it after 300 s ("terminated").
    vi.useFakeTimers();
    const res = fakeResponse();
    const sse = beginSse(res, {}, { heartbeatMs: 1000 });
    vi.advanceTimersByTime(3500);
    expect(res.chunks).toEqual([
      ": keepalive\n\n",
      ": keepalive\n\n",
      ": keepalive\n\n",
    ]);
    sse.close();
    vi.advanceTimersByTime(5000);
    expect(res.chunks).toHaveLength(3);
  });

  it("writes nothing of its own without a heartbeat", () => {
    vi.useFakeTimers();
    const res = fakeResponse();
    beginSse(res);
    vi.advanceTimersByTime(60_000);
    expect(res.chunks).toEqual([]);
  });
});
