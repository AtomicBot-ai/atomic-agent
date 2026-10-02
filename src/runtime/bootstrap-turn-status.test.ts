import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime, type AgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import {
  INTERRUPTED_TURN_ENDING,
  SessionStore,
  createEmptySessionState,
  hostBootAt,
} from "../session/index.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { LogRecord } from "../tracing/structured-logger.js";

/**
 * Every way a turn ends, as the session row records it.
 *
 * The row used to hold a turn only once the turn wrote its end. A turn
 * that never got that far — the app quit while it ran, the process was
 * killed — left the row as it was before the turn; a cancelled first
 * message in a new chat read back as `pending` with nothing in it. Now
 * the row says `running` while the turn runs, and its end, however it
 * comes, replaces that.
 */

function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

function reply(text: string): CompletionResult {
  return {
    content: JSON.stringify({ tool: "reply", args: { text } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

/**
 * A model that holds its answer for the session under test until
 * `release()`, or until the request's signal aborts — and then rejects
 * `unwindMs` later, the way an aborted request takes a moment to come
 * back. Side calls on other ids (session naming, reflection) answer at
 * once.
 */
function heldModel(unwindMs = 0) {
  const state = { target: "", entered: 0 };
  let release: () => void = () => undefined;
  const llamaComplete = async (params: {
    sessionId: string;
    signal?: AbortSignal;
  }): Promise<CompletionResult> => {
    if (params.sessionId !== state.target) return reply("ok");
    state.entered += 1;
    const signal = params.signal;
    const outcome = await new Promise<"released" | "aborted">((resolve) => {
      release = () => resolve("released");
      if (signal?.aborted) {
        resolve("aborted");
        return;
      }
      signal?.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
    });
    if (outcome === "aborted") {
      if (unwindMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, unwindMs));
      }
      throw signal?.reason ?? new DOMException("aborted", "AbortError");
    }
    return reply("done");
  };
  return { state, llamaComplete, release: () => release() };
}

async function waitFor(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

function userTexts(turns: readonly { kind: string }[]): string[] {
  return turns
    .filter((turn) => turn.kind === "user")
    .map((turn) => (turn as { text: string }).text);
}

describe("a turn's status in the session store", () => {
  let stateDir: string;
  let workingDir: string;
  let dbFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-turn-status-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-turn-status-"));
    dbFile = join(stateDir, "sessions.sqlite");
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  async function boot(
    llamaComplete: (params: {
      sessionId: string;
      signal?: AbortSignal;
    }) => Promise<CompletionResult>,
    handlers: {
      onAgentEvent?: (event: AgentLoopEvent) => void;
      logs?: LogRecord[];
    } = {},
  ): Promise<AgentRuntime> {
    const logs = handlers.logs;
    return createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        ...(handlers.onAgentEvent ? { onAgentEvent: handlers.onAgentEvent } : {}),
        ...(logs ? { logSinks: [(record: LogRecord) => logs.push(record)] } : {}),
      },
      overrides: {
        browserBackend: inertBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete,
      },
    });
  }

  function turnOwner(runtime: AgentRuntime, id: string): string | null | undefined {
    const row = runtime.sessionStore
      .getDatabaseHandleForRetention()
      .prepare(`SELECT turn_owner AS turnOwner FROM sessions WHERE id = ?`)
      .get(id) as { turnOwner: string | null } | undefined;
    return row?.turnOwner;
  }

  /** The row as the next process to open the file would find it. */
  function readBack<T>(read: (store: SessionStore) => T): T {
    const store = new SessionStore({ dbFile });
    try {
      return read(store);
    } finally {
      store.close();
    }
  }

  it("says running for as long as the turn runs, and the turn's end replaces it", async () => {
    const model = heldModel();
    const runtime = await boot(model.llamaComplete);
    try {
      const session = runtime.createSession();
      model.state.target = session.id;
      const turn = runtime.runTurn(session, "hello", {
        origin: "tui",
        maxSteps: 4,
      });
      expect(await waitFor(() => model.state.entered === 1)).toBe(true);
      expect(runtime.sessionStore.load(session.id)?.status).toBe("running");
      expect(turnOwner(runtime, session.id)).toContain(`"pid":${process.pid}`);

      model.release();
      const result = await turn;
      expect(result.reason).toBe("reply");
      expect(runtime.sessionStore.load(session.id)?.status).toBe("pending");
      expect(turnOwner(runtime, session.id)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("stores a stopped turn as cancelled, with the message it was sent", async () => {
    const model = heldModel(20);
    const runtime = await boot(model.llamaComplete);
    try {
      const session = runtime.createSession();
      model.state.target = session.id;
      const controller = new AbortController();
      const turn = runtime.runTurn(session, "stop me", {
        origin: "tui",
        maxSteps: 4,
        signal: controller.signal,
      });
      expect(await waitFor(() => model.state.entered === 1)).toBe(true);
      controller.abort();
      const result = await turn;
      expect(result.reason).toBe("cancelled");
      const stored = runtime.sessionStore.load(session.id);
      expect(stored?.status).toBe("cancelled");
      expect(userTexts(stored?.turns ?? [])).toEqual(["stop me"]);
      expect(stored?.turnCount).toBe(1);
      expect(turnOwner(runtime, session.id)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("does not leave a turn that threw marked running", async () => {
    let armed = false;
    const model = heldModel();
    const runtime = await boot(model.llamaComplete, {
      onAgentEvent: (event) => {
        if (armed && event.type === "turn_started") {
          throw new Error("host hook blew up");
        }
      },
    });
    try {
      const session = runtime.createSession();
      model.state.target = session.id;
      armed = true;
      await expect(
        runtime.runTurn(session, "boom", { origin: "tui", maxSteps: 4 }),
      ).rejects.toThrow(/host hook blew up/);
      armed = false;
      const stored = runtime.sessionStore.load(session.id);
      expect(stored?.status).toBe("failed");
      expect(stored?.lastError).toBe("host hook blew up");
      expect(turnOwner(runtime, session.id)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("stores a turn that threw after it was stopped as cancelled", async () => {
    const controller = new AbortController();
    let armed = false;
    const model = heldModel();
    const runtime = await boot(model.llamaComplete, {
      onAgentEvent: (event) => {
        if (armed && event.type === "turn_started") {
          controller.abort();
          throw new Error("hook failed while stopping");
        }
      },
    });
    try {
      const session = runtime.createSession();
      model.state.target = session.id;
      armed = true;
      await expect(
        runtime.runTurn(session, "boom", {
          origin: "tui",
          maxSteps: 4,
          signal: controller.signal,
        }),
      ).rejects.toThrow(/hook failed while stopping/);
      armed = false;
      const stored = runtime.sessionStore.load(session.id);
      expect(stored?.status).toBe("cancelled");
      expect(stored?.lastError).toBeNull();
      expect(turnOwner(runtime, session.id)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("lets a turn its host stopped write its own end before shutdown closes the store", async () => {
    // What every host does on quit: stop its turn, then shut the runtime
    // down. The aborted request takes a moment to come back; the store
    // used to be closed by then, and the row kept its pre-turn state.
    const model = heldModel(50);
    const runtime = await boot(model.llamaComplete);
    const session = runtime.createSession();
    model.state.target = session.id;
    const controller = new AbortController();
    const turn = runtime.runTurn(session, "quit mid-turn", {
      origin: "tui",
      maxSteps: 4,
      signal: controller.signal,
    });
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    controller.abort();
    await runtime.shutdown();
    const result = await turn;
    expect(result.reason).toBe("cancelled");

    const stored = readBack((store) => store.load(session.id));
    expect(stored?.status).toBe("cancelled");
    expect(userTexts(stored?.turns ?? [])).toEqual(["quit mid-turn"]);
    // The turn's own end, not shutdown's stand-in for it.
    expect(stored?.lastError).toBeNull();
  });

  it("records a turn nobody stopped as interrupted at shutdown", async () => {
    // Nothing stops a scheduled task's turn when the app quits, and
    // shutdown does not wait for it: its model never answers here.
    const model = heldModel();
    const runtime = await boot(model.llamaComplete);
    const session = runtime.createSession();
    model.state.target = session.id;
    const controller = new AbortController();
    const turn = runtime
      .runTurn(session, "background work", {
        origin: "scheduler",
        maxSteps: 4,
        signal: controller.signal,
      })
      .catch(() => undefined);
    expect(await waitFor(() => model.state.entered === 1)).toBe(true);
    expect(runtime.sessionStore.load(session.id)?.status).toBe("running");
    await runtime.shutdown();

    const stored = readBack((store) => store.load(session.id));
    expect(stored?.status).toBe(INTERRUPTED_TURN_ENDING.status);
    expect(stored?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
    // Its end never came, so the transcript is the one before it.
    expect(stored?.turns).toEqual([]);

    // Let the abandoned turn unwind, so the test leaves nothing running.
    controller.abort();
    await turn;
  });

  it("ends, at boot, a turn left running by a process that is gone, and leaves a live one", async () => {
    // A process that has exited; its pid is free.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const seedRunning = (id: string, pid: number): void => {
      const store = new SessionStore({
        dbFile,
        turnOwnerProbe: { pid, bootAt: hostBootAt(), isAlive: () => true },
      });
      try {
        store.save(createEmptySessionState({ id, workingDir }));
        expect(store.beginTurn(id)).toBe(true);
      } finally {
        // Closing is not ending the turn: that process died mid-turn.
        store.close();
      }
    };
    seedRunning("s-dead-owner", deadPid);
    // The process that started this test's runner: alive throughout.
    seedRunning("s-live-owner", process.ppid);

    const logs: LogRecord[] = [];
    const model = heldModel();
    const runtime = await boot(model.llamaComplete, { logs });
    try {
      const dead = runtime.sessionStore.load("s-dead-owner");
      expect(dead?.status).toBe("cancelled");
      expect(dead?.lastError).toBe(INTERRUPTED_TURN_ENDING.lastError);
      expect(turnOwner(runtime, "s-dead-owner")).toBeNull();
      expect(runtime.sessionStore.load("s-live-owner")?.status).toBe("running");
      expect(
        logs.some(
          (record) =>
            record.message ===
            "sessions left mid-turn by a stopped agent marked cancelled",
        ),
      ).toBe(true);
    } finally {
      await runtime.shutdown();
    }
    // Shutting down does not touch a turn another process owns.
    expect(readBack((store) => store.load("s-live-owner")?.status)).toBe(
      "running",
    );
  });
});
