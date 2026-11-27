import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationTurn } from "../session/conversation-turn.js";
import type { TuiAction } from "./tui-action.js";
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
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";

/**
 * `/rewind` (ATO-1057): the orchestrator lists the chat's earlier
 * questions, and on a pick takes that question and everything after it
 * out of the session it holds and the store, rebuilds the transcript and
 * puts the question back in the composer. Refused while anything runs.
 * ATO-2467: a pick first checks which files would change and offers
 * "Chat and files / Chat only / Files only"; the files are put back by
 * the same shared rewind the HTTP routes use.
 */

let stateDir = "";
let work = "";
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "aa-tui-rw-state-"));
  work = mkdtempSync(join(tmpdir(), "aa-tui-rw-work-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

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
      paths: { stateDir },
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
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  return { orchestrator, stored, turns, save, clearTurnProgress, cancelSessionCompaction, actions };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const texts = (state: SessionState): string[] =>
  state.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : t.kind));

describe("ChatOrchestrator /rewind", () => {
  it("opens the picker with the questions, newest first", () => {
    const h = makeHarness();
    h.orchestrator.openRewindPicker();
    const opened = h.actions.find((a) => a.type === "rewind_picker_opened");
    expect(opened?.type === "rewind_picker_opened" && opened.points.map((p) => [p.text, p.turnIndex])).toEqual([
      ["second question", 2],
      ["first question", 0],
    ]);
  });

  it("says so instead of opening on a chat with no questions", () => {
    const h = makeHarness({ initial: createEmptySessionState({ id: "s-a", workingDir: "/tmp" }) });
    h.orchestrator.openRewindPicker();
    expect(h.actions.some((a) => a.type === "rewind_picker_opened")).toBe(false);
    expect(h.actions.some((a) => a.type === "system_message" && a.text.startsWith("Nothing to rewind"))).toBe(true);
  });

  it("refuses to open while a turn runs", () => {
    const h = makeHarness();
    h.orchestrator.sendMessage("third question");
    h.actions.length = 0;
    h.orchestrator.openRewindPicker();
    expect(h.actions.some((a) => a.type === "rewind_picker_opened")).toBe(false);
    expect(h.actions.some((a) => a.type === "system_message" && a.text.startsWith("Can't rewind while"))).toBe(true);
  });

  /** The agent wrote a.txt during the second question (at 3): v0 before it, v1 now. */
  async function agentChangedFile(): Promise<string> {
    const a = join(work, "a.txt");
    writeFileSync(a, "v0");
    const store = new FileCheckpointStore(fileCheckpointsRoot(stateDir), () => 3);
    await store.capture("s-a", a, "os.fs.write");
    writeFileSync(a, "v1");
    return a;
  }

  const lastNote = (actions: TuiAction[]): string => {
    const notes = actions.filter((a) => a.type === "system_message");
    const last = notes[notes.length - 1];
    return last?.type === "system_message" ? last.text : "";
  };

  it("offers the file choices with the count of files that would change", async () => {
    await agentChangedFile();
    const h = makeHarness();
    await h.orchestrator.openRewindChoice(2, "second question");
    expect(h.actions).toContainEqual({
      type: "rewind_choice_ready",
      turnIndex: 2,
      facts: { fileCount: 1, notRestorableCount: 0, incomplete: false, uncoveredCount: 0 },
    });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("offers no file change for a point the agent changed nothing after", async () => {
    const h = makeHarness();
    await h.orchestrator.openRewindChoice(0, "first question");
    const ready = h.actions.find((a) => a.type === "rewind_choice_ready");
    expect(ready?.type === "rewind_choice_ready" && ready.facts.fileCount).toBe(0);
  });

  it("closes the box and says why when the pick no longer matches the chat", async () => {
    const h = makeHarness();
    await h.orchestrator.openRewindChoice(2, "a question never asked");
    expect(h.actions.map((a) => a.type)).toEqual(["rewind_picker_closed", "system_message"]);
    expect(lastNote(h.actions)).toBe("The chat changed since the list was opened. Run /rewind again.");
  });

  it("chat only: cuts back to before the picked question, saves, rebuilds and refills the composer", async () => {
    const a = await agentChangedFile();
    const h = makeHarness();
    h.actions.length = 0;
    await h.orchestrator.rewindTo(0, "first question", "conversation");
    expect(h.cancelSessionCompaction).toHaveBeenCalledWith("s-a");
    expect(h.clearTurnProgress).toHaveBeenCalledWith("s-a");
    expect(h.stored.get("s-a")!.turns).toEqual([]);
    const types = h.actions.map((a) => a.type);
    expect(types.indexOf("session_switched")).toBeLessThan(types.indexOf("input_changed"));
    const switched = h.actions.find((a) => a.type === "session_switched");
    expect(switched?.type === "session_switched" && switched.sessionId).toBe("s-a");
    expect(switched?.type === "session_switched" && switched.messages).toEqual([]);
    expect(h.actions).toContainEqual({ type: "input_changed", value: "first question" });
    expect(lastNote(h.actions)).toContain("Files the agent changed were not restored");
    expect(readFileSync(a, "utf8")).toBe("v1");

    // The next message runs on the cut session.
    h.orchestrator.sendMessage("first question, edited");
    expect(h.turns[0]!.session.turns).toHaveLength(0);
    h.turns[0]!.finish();
    await settle();
  });

  it("chat and files: puts the file back, then cuts the chat", async () => {
    const a = await agentChangedFile();
    const h = makeHarness();
    await h.orchestrator.rewindTo(2, "second question", "all");
    expect(readFileSync(a, "utf8")).toBe("v0");
    expect(texts(h.stored.get("s-a")!)).toEqual(["first question", "first answer"]);
    expect(h.actions).toContainEqual({ type: "input_changed", value: "second question" });
    expect(lastNote(h.actions)).toContain("1 file the agent changed was put back");
  });

  it("files only: puts the file back and leaves the chat as it is", async () => {
    const a = await agentChangedFile();
    const h = makeHarness();
    await h.orchestrator.rewindTo(2, "second question", "files");
    expect(readFileSync(a, "utf8")).toBe("v0");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.actions.some((a2) => a2.type === "session_switched" || a2.type === "input_changed")).toBe(false);
    expect(lastNote(h.actions)).toBe("Put back 1 file to how it was before that message. The chat stays as it is.");
  });

  it("says in plain words which file it could not put back", async () => {
    // The agent edited sub/a.txt; since then the folder `sub` became a file,
    // so the saved copy cannot be written back.
    const sub = join(work, "sub");
    const a = join(sub, "a.txt");
    mkdirSync(sub);
    writeFileSync(a, "v0");
    await new FileCheckpointStore(fileCheckpointsRoot(stateDir), () => 3).capture("s-a", a, "os.fs.edit");
    rmSync(sub, { recursive: true });
    writeFileSync(sub, "not a folder");
    const h = makeHarness();
    await h.orchestrator.rewindTo(2, "second question", "files");
    expect(lastNote(h.actions)).toBe(
      "The chat stays as it is. Couldn't put back 1 file (a.txt): it was left as it is. Check that it isn't open or read-only, then try /rewind again.",
    );
    expect(lastNote(h.actions)).not.toContain(work);
  });

  it("keeps the turns before the picked question", async () => {
    const h = makeHarness();
    await h.orchestrator.rewindTo(2, "second question", "conversation");
    expect(texts(h.stored.get("s-a")!)).toEqual(["first question", "first answer"]);
  });

  it("refuses a pick that no longer matches the chat and changes nothing", async () => {
    const h = makeHarness();
    await h.orchestrator.rewindTo(2, "a question never asked", "all");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.actions.some((a) => a.type === "input_changed")).toBe(false);
  });

  it("refuses while another origin runs a turn on the chat", async () => {
    const h = makeHarness({ busy: true });
    await h.orchestrator.rewindTo(0, "first question", "all");
    await h.orchestrator.openRewindChoice(0, "first question");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.actions.some((a) => a.type === "rewind_choice_ready")).toBe(false);
  });
});
