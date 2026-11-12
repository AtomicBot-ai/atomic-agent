import { describe, expect, it, vi } from "vitest";

import type { ConversationTurn } from "../session/conversation-turn.js";
import {
  createEmptySessionState,
  incrementTurnCount,
  recordTurn,
  type SessionState,
} from "../session/session-state.js";
import { summarizeSessionState } from "../session/session-summary.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";

/**
 * `[try again]` on the last question (ATO-1302): the orchestrator takes
 * that turn back out of the session it holds and the store, under the
 * same rules as `POST /api/sessions/{id}/rollback-last-turn`, and
 * refuses while anything is running or parked.
 */

const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

const user = (text: string, at: number): ConversationTurn => ({ kind: "user", text, at });
const reply = (text: string, at: number): ConversationTurn => ({
  kind: "assistant_reply",
  text,
  at,
});

function turn(state: SessionState, ...rows: ConversationTurn[]): SessionState {
  let next = state;
  for (const row of rows) next = recordTurn(next, row);
  return { ...incrementTurnCount(next), status: "completed" };
}

function twoTurnSession(): SessionState {
  let state = createEmptySessionState({ id: "s-a", workingDir: "/tmp" });
  state = turn(state, user("first question", 1), reply("first answer", 2));
  state = turn(state, user("second question", 3), reply("second answer", 4));
  return state;
}

function makeHarness(opts: { busy?: boolean; initial?: SessionState } = {}) {
  const stored = new Map<string, SessionState>([["s-a", opts.initial ?? twoTurnSession()]]);
  const turns: Array<{ session: SessionState; text: string; finish: () => void }> = [];
  const save = vi.fn((state: SessionState) => {
    stored.set(state.id, state);
  });
  const clearTurnProgress = vi.fn();
  const cancelSessionCompaction = vi.fn(() => false);
  const runtime = {
    createSession: () => createEmptySessionState({ id: "s-new", workingDir: "/tmp" }),
    steer: () => false,
    runTurn: (session: SessionState, text: string) =>
      new Promise((resolve) => {
        turns.push({
          session,
          text,
          finish: () =>
            resolve({
              session: turn(session, user(text, 10), reply("new answer", 11)),
              reason: "reply",
              stepCount: 1,
            }),
        });
      }),
    sessionStore: {
      listSummaryPage: ({ limit }: { limit: number }) =>
        [...stored.values()].map(summarizeSessionState).slice(0, limit),
      countUnreadable: () => 0,
      listRecent: () => [...stored.values()],
      load: (id: string) => stored.get(id) ?? null,
      save,
      clearTurnProgress,
      delete: () => undefined,
    },
    cancelSessionCompaction,
    approvals: {
      clearSessionGrants: vi.fn(),
      denyPendingForSession: vi.fn(() => 0),
      pendingRequestForSession: () => null,
    },
    turnController: { isBusy: () => opts.busy === true },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
  } as unknown as AgentRuntime;
  const bus = makeTuiEventBus();
  const orchestrator = new ChatOrchestrator(runtime, bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: cloudGateFacts,
  });
  orchestrator.switchSession("s-a");
  return { orchestrator, stored, turns, save, clearTurnProgress, cancelSessionCompaction };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ChatOrchestrator.rollbackLastTurn", () => {
  it("cuts the last question and answer from the store and the next turn", async () => {
    const h = makeHarness();
    const outcome = h.orchestrator.rollbackLastTurn();
    expect(outcome).toEqual({ ok: true, text: "second question" });
    expect(h.cancelSessionCompaction).toHaveBeenCalledWith("s-a");
    expect(h.clearTurnProgress).toHaveBeenCalledWith("s-a");
    // What `/resume` will load: one question, one answer.
    const saved = h.stored.get("s-a")!;
    expect(saved.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind))).toEqual([
      "first question",
      "first answer",
    ]);
    expect(saved.turnCount).toBe(1);

    // The resend runs on the cut session, not on the one it replaced.
    h.orchestrator.sendMessage("second question");
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.session.turns).toHaveLength(2);
    h.turns[0]!.finish();
    await settle();
  });

  it("refuses while a turn of its own is running", () => {
    const h = makeHarness();
    h.orchestrator.sendMessage("third question");
    expect(h.orchestrator.rollbackLastTurn()).toEqual({ ok: false, code: "turn_in_progress" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refuses while a message is queued behind the running turn", async () => {
    const h = makeHarness();
    h.orchestrator.sendMessage("third question");
    h.orchestrator.sendMessage("parked");
    h.turns[0]!.finish();
    // The parked message drains into the next turn at once; the chat is
    // busy again and still refuses.
    await settle();
    expect(h.orchestrator.rollbackLastTurn()).toEqual({ ok: false, code: "turn_in_progress" });
  });

  it("refuses when another origin runs a turn on the chat", () => {
    const h = makeHarness({ busy: true });
    expect(h.orchestrator.rollbackLastTurn()).toEqual({ ok: false, code: "turn_in_progress" });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("passes the planner's refusal through and changes nothing", () => {
    const withTools = turn(
      twoTurnSession(),
      user("read the file", 5),
      { kind: "assistant_tool_call", tool: "os.fs.read", args: { path: "a.txt" }, at: 6 },
      { kind: "tool_result", tool: "os.fs.read", status: "ok", summary: "ok", at: 7 },
      reply("done", 8),
    );
    const h = makeHarness({ initial: withTools });
    expect(h.orchestrator.rollbackLastTurn()).toEqual({ ok: false, code: "turn_has_tools" });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.stored.get("s-a")).toBe(withTools);
  });

  it("refuses a different stored last question than the one clicked", () => {
    const h = makeHarness();
    expect(h.orchestrator.rollbackLastTurn({ expectText: "a question never stored" })).toEqual({
      ok: false,
      code: "turn_mismatch",
    });
    // Same text, wrong position: a failed copy of the question that never reached the store.
    expect(
      h.orchestrator.rollbackLastTurn({ expectText: "second question", expectPriorQuestions: 2 }),
    ).toEqual({ ok: false, code: "turn_mismatch" });
    expect(h.save).not.toHaveBeenCalled();
    expect(
      h.orchestrator.rollbackLastTurn({ expectText: "second question", expectPriorQuestions: 1 }).ok,
    ).toBe(true);
  });

  it("falls back for a stopped turn: the stop may have cut a tool short", () => {
    const stopped = turn(twoTurnSession(), user("delete the build folder", 5), {
      kind: "assistant_reply",
      text: "(stopped)",
      stopped: true,
      at: 6,
    });
    const h = makeHarness({ initial: stopped });
    expect(h.orchestrator.rollbackLastTurn()).toEqual({ ok: false, code: "turn_stopped" });
    expect(h.save).not.toHaveBeenCalled();
  });
});
