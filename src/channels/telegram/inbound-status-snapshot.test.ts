import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";

import { createAttachmentInbox } from "../attachments/inbox.js";
import { handleInboundText, type InboundContext, type InboundTextUpdate } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";

// ATO-965: `/status` for this chat's running turn, and the auto snapshot
// that edits ONE bubble on a long turn.

const OWNER = 42;
const CHAT = 100;

function update(text: string): InboundTextUpdate {
  return { from: { id: OWNER }, chat: { id: CHAT, type: "private" }, text, message_id: 1 };
}

function stepFinished(stepIndex: number): AgentLoopEvent {
  return { type: "step_finished", stepIndex, summary: "raw /private/path output", durationMs: 1 } as AgentLoopEvent;
}

function shellRun(exitCode: number): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: {
        tool: "os.shell.run",
        status: exitCode === 0 ? "ok" : "error",
        summary: "raw /private/path output",
        details: { cmd: "npm", args: ["test"], exitCode },
        truncated: false,
      },
      batchIndex: 0,
      batchSize: 1,
    },
  } as AgentLoopEvent;
}

function reply(text: string): AgentLoopEvent {
  return { type: "llm_event", event: { type: "assistant_reply", text } } as AgentLoopEvent;
}

interface Api extends TelegramApi {
  sent: { text: string; opts?: Record<string, unknown> }[];
  edits: { messageId: number; text: string }[];
}

function makeApi(editError?: Error): Api {
  const sent: Api["sent"] = [];
  const edits: Api["edits"] = [];
  return {
    sent,
    edits,
    sendMessage: vi.fn(async (_chat: number, text: string, opts?: Record<string, unknown>) => {
      sent.push({ text, ...(opts ? { opts } : {}) });
      return { message_id: sent.length };
    }),
    editMessageText: vi.fn(async (_chat: number, messageId: number, text: string) => {
      if (editError) throw editError;
      edits.push({ messageId, text });
      return true;
    }),
    deleteMessage: vi.fn(async () => true),
  };
}

/** A runtime whose turn fires `events`, then waits for `release` (when given). */
function makeRuntime(events: AgentLoopEvent[], release?: Promise<void>): AgentRuntime {
  const sessions: SessionState[] = [];
  return {
    createSession: () => {
      const s = createEmptySessionState({ id: `s-${sessions.length + 1}`, workingDir: "/w" });
      sessions.push(s);
      return s;
    },
    sessionStore: { load: (id: string) => sessions.find((s) => s.id === id) ?? null },
    turnController: { isBusy: () => false },
    runTurn: async (session: SessionState, _m: string, opts?: { eventHook?: (e: AgentLoopEvent) => void }) => {
      for (const event of events) opts?.eventHook?.(event);
      if (release) await release;
      return { session, reason: "reply" as const, stepCount: events.length };
    },
  } as unknown as AgentRuntime;
}

describe("Telegram status snapshots (ATO-965)", () => {
  let dir: string;
  let pointer: TelegramSessionPointer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-tg-status-"));
    pointer = new TelegramSessionPointer(join(dir, "telegram-session.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function ctx(runtime: AgentRuntime, api: TelegramApi, extra: Partial<InboundContext> = {}): InboundContext {
    return {
      runtime,
      api,
      sessionPointer: pointer,
      logger: new StructuredLogger({ level: "warn", sinks: [] }),
      ownerUserId: OWNER,
      inflight: new Map(),
      liveTurns: new Map(),
      inbox: createAttachmentInbox({ dir: join(dir, "inbox") }),
      mediaGroups: new Map(),
      scheduleKeepalive: () => () => undefined,
      scheduleSnapshotPoll: () => () => undefined,
      statusSnapshot: { everySteps: 10, everyMs: 0 },
      ...extra,
    };
  }

  it("turns the progress bubble of a long turn into a snapshot, edited in place", async () => {
    const events = [
      ...Array.from({ length: 9 }, (_, i) => stepFinished(i)),
      shellRun(0),
      stepFinished(9),
      reply("done"),
    ];
    const api = makeApi();
    await handleInboundText(update("do the long thing"), ctx(makeRuntime(events), api));
    const snapshots = api.edits.filter((e) => e.text.includes("Blocked:"));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.messageId).toBe(1); // the progress bubble, not a new message
    expect(snapshots[0]!.text).toContain("Last result: tests passed");
    expect(snapshots[0]!.text).toContain("10 steps");
    expect(snapshots[0]!.text).not.toContain("/private/path");
    // Only the bubble and the reply were sent: no message per snapshot.
    expect(api.sent.map((m) => m.text)).toEqual(["🤔 Thinking…", "done"]);
  });

  it("leaves a short turn alone", async () => {
    const api = makeApi();
    const events = [stepFinished(0), stepFinished(1), reply("ok")];
    await handleInboundText(update("quick"), ctx(makeRuntime(events), api));
    expect(api.edits.some((e) => e.text.includes("Blocked:"))).toBe(false);
  });

  it("posts a new bubble when the old one can no longer be edited", async () => {
    const api = makeApi(new Error("Bad Request: message to edit not found"));
    const events = [...Array.from({ length: 10 }, (_, i) => stepFinished(i)), reply("done")];
    await handleInboundText(update("long"), ctx(makeRuntime(events), api));
    const texts = api.sent.map((m) => m.text);
    expect(texts[0]).toBe("🤔 Thinking…");
    expect(texts[1]).toContain("Blocked: no");
    expect(api.sent[1]!.opts).toMatchObject({ disable_notification: true });
    expect(texts[texts.length - 1]).toBe("done");
  });

  it("posts its own snapshot bubble when the progress indicator is off", async () => {
    const api = makeApi();
    const events = [...Array.from({ length: 10 }, (_, i) => stepFinished(i)), reply("done")];
    await handleInboundText(update("long"), ctx(makeRuntime(events), api, { progressIndicator: false }));
    expect(api.sent).toHaveLength(2);
    expect(api.sent[0]!.text).toContain("Blocked: no");
    expect(api.sent[1]!.text).toBe("done");
    expect(api.deleteMessage).toHaveBeenCalled();
  });

  it("sends nothing extra when snapshots are off", async () => {
    const api = makeApi();
    const events = [...Array.from({ length: 30 }, (_, i) => stepFinished(i)), reply("done")];
    await handleInboundText(
      update("long"),
      ctx(makeRuntime(events), api, { statusSnapshot: { everySteps: 0, everyMs: 0 } }),
    );
    expect(api.edits.some((e) => e.text.includes("Blocked:"))).toBe(false);
  });

  it("/status describes this chat's running turn, approval wait included", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = makeApi();
    const c = ctx(makeRuntime([stepFinished(0), shellRun(1), stepFinished(1)], gate), api, {
      pendingApprovalTool: () => "os.fs.write",
    });
    const turn = handleInboundText(update("work"), c);
    await vi.waitFor(() => expect(c.inflight.size).toBe(1));
    await handleInboundText(update("/status"), c);
    const status = api.sent.find((m) => m.text.startsWith("This chat's turn:"));
    expect(status).toBeDefined();
    expect(status!.text).toContain("Now: waiting for your approval of os.fs.write");
    expect(status!.text).toContain("Last result: tests failed (exit 1)");
    expect(status!.text).toContain("Blocked: yes, on your approval of os.fs.write");
    expect(status!.text).toContain("2 steps");
    expect(status!.text).toContain("Session: s-1");
    release();
    await turn;
    expect(c.liveTurns!.size).toBe(0);
  });

  it("/status without a running turn keeps the session lines only", async () => {
    const api = makeApi();
    await handleInboundText(update("/status"), ctx(makeRuntime([]), api));
    expect(api.sent[0]!.text).not.toContain("This chat's turn");
    expect(api.sent[0]!.text).toContain("No active session");
  });
});
