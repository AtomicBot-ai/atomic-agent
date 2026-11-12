import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../config/index.js";
import { createCompactionDefaults } from "../config/agent/compaction-config.js";
import { createEmptySessionState, recordTurn, type SessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import type { BuildPromptInput } from "../prompt/build-prompt-types.js";
import { PLAIN_INSTRUCT_PROFILE, type PrefixReuse } from "../llm/model-profile.js";
import type { CompactionEvent } from "../agent/compaction-control.js";
import { TurnController } from "./turn-controller.js";
import { createContextCompaction, noSliceFitsMessage } from "./context-compaction.js";

// ATO-1295: the planner's "no cut fits" outcome is forced here, so the
// test is about what the runtime says about it, not about building a
// transcript that happens to defeat every cut.
vi.mock("../prompt/plan-compaction.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../prompt/plan-compaction.js")>();
  return { ...original, decideCompaction: vi.fn(() => ({ plan: null, skip: "no_reduction" })) };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "context-compaction-no-slice-"));
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
  resetConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(dir, { recursive: true, force: true }); });

function history(): SessionState {
  let state = recordTurn(createEmptySessionState({ id: "chat", workingDir: dir }), userTurn("read the files"));
  for (let i = 0; i < 4; i++) {
    state = recordTurn(state, assistantToolCallTurn({ tool: "os.fs.read", args: { path: `/file-${i}` } }));
    state = recordTurn(state, toolResultTurn({ tool: "os.fs.read", status: "ok", summary: `result ${i}` }));
  }
  return state;
}

function input(session: SessionState, prefixReuse: PrefixReuse, contextWindow = 16_384): BuildPromptInput {
  return { session, toolDescriptors: [], skillCatalog: [], profile: { ...PLAIN_INSTRUCT_PROFILE, prefixReuse },
    contextWindow, conversationMaxTokens: 4000, conversationMaxPairs: 200,
    capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false } };
}

function fixture(state: SessionState) {
  const events: CompactionEvent[] = [];
  const warn = vi.fn();
  const complete = vi.fn();
  const service = createContextCompaction({
    config: () => createCompactionDefaults(), sessionStore: { load: (id) => id === state.id ? state : null },
    turnController: new TurnController(), complete, warn, persist: vi.fn(),
    route: (_id: string, providerId?: string) => ({ providerId: providerId ?? "current", transport: "grammar" as const, serverTemplate: true }),
    emit: (event) => events.push(event), sideCallSlotId: () => 3, promptInput: (s) => input(s, "none"),
  });
  return { ...service, events, warn, complete };
}

describe("automatic compaction with no cut that fits (ATO-1295)", () => {
  it("says so once per session and window on a model without prefix reuse", () => {
    const state = history();
    const f = fixture(state);
    const signal = new AbortController().signal;
    expect(f.control.beforeStep(input(state, "none"), { signal })).toBeUndefined();
    expect(f.control.beforeStep(input(state, "none"), { signal })).toBeUndefined();
    const notices = f.events.filter((event) => event.type === "compaction_failed");
    expect(notices).toEqual([{ type: "compaction_failed", sessionId: state.id,
      result: { status: "noop", reason: "threshold", message: noSliceFitsMessage(16_384) },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, calls: 0 }]);
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    // Another window is told again, once.
    f.control.beforeStep(input(state, "none", 24_576), { signal });
    f.control.beforeStep(input(state, "none", 24_576), { signal });
    expect(f.events.filter((event) => event.type === "compaction_failed")).toHaveLength(2);
  });

  it("stays quiet on a model with partial prefix reuse", () => {
    const state = history();
    const f = fixture(state);
    const signal = new AbortController().signal;
    f.control.beforeStep(input(state, "partial"), { signal });
    expect(f.events.filter((event) => event.type === "compaction_failed")).toEqual([]);
  });

  it("names the window and the fix", () => {
    expect(noSliceFitsMessage(16_384)).toContain("(16384 tokens)");
    expect(noSliceFitsMessage(16_384)).toContain("older turns are trimmed instead of summarized");
    expect(noSliceFitsMessage(16_384)).toContain("raise the context size");
    expect(noSliceFitsMessage(null)).not.toContain("tokens)");
  });
});
