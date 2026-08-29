import { describe, expect, it, vi } from "vitest";
import { handleEditorSubmit } from "./submit-handler.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
import type { TuiAppCallbacks } from "./tui-app.js";

function fakeSession(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: "s1",
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    ...overrides,
  };
}

function stubCallbacks(
  overrides: Partial<TuiAppCallbacks> = {},
): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

describe("handleEditorSubmit under an approval prompt", () => {
  function pendingState(): TuiState {
    return {
      ...createInitialTuiState(fakeSession()),
      pendingApproval: {
        approvalId: "ap-1",
        sessionId: "s1",
        tool: "os.fs.write",
        category: "fs_write_workspace",
        reason: "replace 1337 bytes into /work/site/index.html",
        redirectablePath: "/work/site/index.html",
      },
    };
  }

  it("answers the prompt with the message instead of starting a turn", () => {
    // The operator typed prose while a call was blocked: that denies
    // the call *with their words* and redirects the running turn — the
    // point being that the run survives.
    const onApprovalReply = vi.fn();
    const onMessageSubmitted = vi.fn();
    const dispatched: Array<{ type: string }> = [];
    handleEditorSubmit(
      "put it in ~/Documents/apple-site instead",
      pendingState(),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onApprovalReply, onMessageSubmitted }),
    );
    expect(onApprovalReply).toHaveBeenCalledWith(
      "ap-1",
      "put it in ~/Documents/apple-site instead",
    );
    expect(onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatched.map((a) => a.type)).toContain("message_steered");
  });

  it("closes the prompt it answered", () => {
    // The reply IS the verdict. Without `approval_resolved` the runtime
    // resolves the call but the UI stays in approval mode forever: every
    // key routes into the approval handler, so there is no menu, no Tab,
    // and Ctrl+C aborts instead of arming the quit chord — the TUI
    // cannot be quit at all.
    const dispatched: Array<{ type: string }> = [];
    handleEditorSubmit(
      "put it somewhere else",
      pendingState(),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onApprovalReply: vi.fn() }),
    );
    expect(dispatched).toContainEqual({
      type: "approval_resolved",
      approvalId: "ap-1",
      approved: false,
    });
  });

  it("never answers a background session's prompt with typed prose", () => {
    // The visible thread is s1; the parked request belongs to another
    // session. The words the operator typed are a message for THEIR
    // thread, not a model-visible deny reason for a question they
    // cannot even see — so the submit takes the ordinary path.
    const onApprovalReply = vi.fn();
    const onMessageSubmitted = vi.fn();
    const state: TuiState = {
      ...createInitialTuiState(fakeSession()),
      pendingApproval: {
        approvalId: "ap-bg",
        sessionId: "s-background",
        tool: "os.shell.run",
        category: "shell",
        reason: "r",
      },
    };
    handleEditorSubmit(
      "carry on with the plan",
      state,
      (() => {}) as never,
      stubCallbacks({ onApprovalReply, onMessageSubmitted }),
    );
    expect(onApprovalReply).not.toHaveBeenCalled();
    expect(onMessageSubmitted).toHaveBeenCalledWith("carry on with the plan");
  });

  it("keeps slash commands local instead of answering the prompt with them", () => {
    // `/privacy` under a prompt is still `/privacy`; sending it to the
    // model as a denial reason would be nonsense.
    const onApprovalReply = vi.fn();
    handleEditorSubmit(
      "/clear",
      pendingState(),
      (() => {}) as never,
      stubCallbacks({ onApprovalReply }),
    );
    expect(onApprovalReply).not.toHaveBeenCalled();
  });
});

describe("handleEditorSubmit", () => {
  it("runs a registered command from the buffer even when the palette is closed", () => {
    const state = createInitialTuiState(fakeSession());
    const systemMessages: string[] = [];
    const dispatch = (a: { type: string; text?: string }): void => {
      if (a.type === "system_message" && a.text) systemMessages.push(a.text);
    };
    handleEditorSubmit("/clear", state, dispatch as never, stubCallbacks());
    expect(systemMessages.some((t) => t.includes("chat cleared"))).toBe(true);
  });

  it("routes the /model catalog ensure through the callback, not dispatch", () => {
    // The orchestrator that owns the /v1/models fetch listens on the
    // event bus; a dispatched request action is a reducer no-op it
    // never sees, which is why /model looked dead in the app.
    const state = createInitialTuiState(fakeSession());
    const dispatched: Array<{ type: string }> = [];
    const onEnsureRequested = vi.fn();
    const onPickerRequested = vi.fn();
    handleEditorSubmit(
      "/model",
      state,
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({
        onProvidersInlineModelsEnsureRequested: onEnsureRequested,
        onProvidersChatModelPickerRequested: onPickerRequested,
      }),
    );
    expect(onEnsureRequested).toHaveBeenCalledWith(null);
    // The Cloud pane no longer opens the modal picker.
    expect(onPickerRequested).not.toHaveBeenCalled();
    expect(
      dispatched.some(
        (a) => a.type === "providers_inline_models_ensure_requested",
      ),
    ).toBe(false);
    // The jump to the LLM tab and the filter focus still travel
    // through the reducer.
    expect(dispatched.some((a) => a.type === "tab_changed")).toBe(true);
    expect(
      dispatched.some((a) => a.type === "llm_cloud_filter_focus_set"),
    ).toBe(true);
  });

  it("with palette open, runs the buffer when it is a full registered command (stale slashQuery)", () => {
    const base = createInitialTuiState(fakeSession());
    const state: TuiState = {
      ...base,
      slashPaletteOpen: true,
      /** Stale: would make `filterSlashCommands(\"\")` return help first. */
      slashQuery: "",
      slashPaletteCursor: 0,
    };
    const systemMessages: string[] = [];
    const dispatch = (a: { type: string; text?: string }): void => {
      if (a.type === "system_message" && a.text) systemMessages.push(a.text);
    };
    handleEditorSubmit("/clear", state, dispatch as never, stubCallbacks());
    expect(systemMessages.some((t) => t.includes("chat cleared"))).toBe(true);
    expect(systemMessages.some((t) => t.includes("slash commands:"))).toBe(
      false,
    );
  });

  it("invokes onDebugBundleExportRequested for /dump", () => {
    const state = createInitialTuiState(fakeSession());
    const onDebugBundleExportRequested = vi.fn();
    const dispatch = vi.fn();
    handleEditorSubmit(
      "/dump",
      state,
      dispatch,
      stubCallbacks({ onDebugBundleExportRequested }),
    );
    expect(onDebugBundleExportRequested).toHaveBeenCalledTimes(1);
    expect(onDebugBundleExportRequested).toHaveBeenCalledWith(state);
  });

  it("maps /privacy level and the approve aliases onto onApprovalLevelSetRequested", () => {
    const state = createInitialTuiState(fakeSession());
    const onApprovalLevelSetRequested = vi.fn();
    const dispatch = vi.fn();
    const callbacks = stubCallbacks({ onApprovalLevelSetRequested });

    handleEditorSubmit("/privacy level 3", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(3);

    handleEditorSubmit("/privacy approve on", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(5);

    handleEditorSubmit("/privacy approve off", state, dispatch, callbacks);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledWith(1);
    expect(onApprovalLevelSetRequested).toHaveBeenCalledTimes(3);
  });
});

describe("handleEditorSubmit while a turn is running", () => {
  function runningState(): TuiState {
    return { ...createInitialTuiState(fakeSession()), status: "running" };
  }

  it("queues the message instead of dropping it", () => {
    const dispatched: Array<{ type: string; text?: string }> = [];
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "and also check the logs",
      runningState(),
      ((a: { type: string; text?: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSubmitted }),
    );
    expect(onMessageSubmitted).toHaveBeenCalledWith("and also check the logs");
    expect(dispatched).toContainEqual({
      type: "message_queued",
      text: "and also check the logs",
    });
  });

  it("never dispatches message_submitted mid-run (it would wipe the live turn)", () => {
    const dispatched: Array<{ type: string }> = [];
    handleEditorSubmit(
      "second thought",
      runningState(),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks(),
    );
    expect(dispatched.some((a) => a.type === "message_submitted")).toBe(false);
  });

  it("drops the submit entirely once the app is quitting", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "too late",
      { ...createInitialTuiState(fakeSession()), status: "quitting" },
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSubmitted }),
    );
    expect(onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatched).toHaveLength(0);
  });

  it("still starts a turn immediately when idle", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "go",
      createInitialTuiState(fakeSession()),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSubmitted }),
    );
    expect(dispatched.some((a) => a.type === "message_submitted")).toBe(true);
    expect(dispatched.some((a) => a.type === "message_queued")).toBe(false);
    expect(onMessageSubmitted).toHaveBeenCalledWith("go");
  });
});

describe("/queue", () => {
  it("lists the parked messages in the transcript", () => {
    const state: TuiState = {
      ...createInitialTuiState(fakeSession()),
      status: "running",
      queuedMessages: ["first", "second"],
    };
    const messages: string[] = [];
    handleEditorSubmit(
      "/queue",
      state,
      ((a: { type: string; text?: string }) => {
        if (a.type === "system_message" && a.text) messages.push(a.text);
      }) as never,
      stubCallbacks(),
    );
    const joined = messages.join("\n");
    expect(joined).toContain("queue (2 messages)");
    expect(joined).toContain("1. first");
    expect(joined).toContain("2. second");
  });

  it("clear empties the reducer slice and tells the orchestrator", () => {
    const state: TuiState = {
      ...createInitialTuiState(fakeSession()),
      status: "running",
      queuedMessages: ["first"],
    };
    const dispatched: Array<{ type: string; queued?: readonly string[] }> = [];
    const onQueueClearRequested = vi.fn();
    handleEditorSubmit(
      "/queue clear",
      state,
      ((a: { type: string; queued?: readonly string[] }) =>
        dispatched.push(a)) as never,
      stubCallbacks({ onQueueClearRequested }),
    );
    expect(onQueueClearRequested).toHaveBeenCalledTimes(1);
    expect(dispatched).toContainEqual({ type: "queue_changed", queued: [] });
  });

  it("says so when there is nothing parked", () => {
    const messages: string[] = [];
    handleEditorSubmit(
      "/queue",
      createInitialTuiState(fakeSession()),
      ((a: { type: string; text?: string }) => {
        if (a.type === "system_message" && a.text) messages.push(a.text);
      }) as never,
      stubCallbacks(),
    );
    expect(messages.join("\n")).toContain("queue: (empty)");
  });
});

describe("steer vs queue while a turn is running", () => {
  function busy(mode: "steer" | "queue"): TuiState {
    return {
      ...createInitialTuiState(fakeSession()),
      status: "running",
      whileBusyMode: mode,
    };
  }

  it("steers when the mode says steer", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSteered = vi.fn();
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "no, use the staging db",
      busy("steer"),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSteered, onMessageSubmitted }),
    );
    expect(onMessageSteered).toHaveBeenCalledWith("no, use the staging db");
    expect(onMessageSubmitted).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === "message_steered")).toBe(true);
    expect(dispatched.some((a) => a.type === "message_queued")).toBe(false);
  });

  it("queues when the mode says queue", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSteered = vi.fn();
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "afterwards, run the tests",
      busy("queue"),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSteered, onMessageSubmitted }),
    );
    expect(onMessageSubmitted).toHaveBeenCalledWith("afterwards, run the tests");
    expect(onMessageSteered).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === "message_queued")).toBe(true);
  });

  it("falls back to queueing when the host wired no steer callback", () => {
    // Steering is optional on the callback surface; a host that does not
    // implement it must still not drop the message.
    const dispatched: Array<{ type: string }> = [];
    const onMessageSubmitted = vi.fn();
    handleEditorSubmit(
      "still needs to land",
      busy("steer"),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSubmitted }),
    );
    expect(onMessageSubmitted).toHaveBeenCalledWith("still needs to land");
    expect(dispatched.some((a) => a.type === "message_queued")).toBe(true);
  });

  it("/steer <msg> lands one message without changing the mode", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSteered = vi.fn();
    const onWhileBusyModePersistRequested = vi.fn();
    handleEditorSubmit(
      "/steer drop what you are doing",
      busy("queue"),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSteered, onWhileBusyModePersistRequested }),
    );
    expect(onMessageSteered).toHaveBeenCalledWith("drop what you are doing");
    expect(
      dispatched.some((a) => a.type === "while_busy_mode_changed"),
    ).toBe(false);
    // The message-carrying form is a one-off: nothing reaches the config file.
    expect(onWhileBusyModePersistRequested).not.toHaveBeenCalled();
  });

  it("/queue <msg> parks one message without changing the mode", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSubmitted = vi.fn();
    const onMessageSteered = vi.fn();
    const onWhileBusyModePersistRequested = vi.fn();
    handleEditorSubmit(
      "/queue and then deploy",
      busy("steer"),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({
        onMessageSubmitted,
        onMessageSteered,
        onWhileBusyModePersistRequested,
      }),
    );
    expect(onMessageSubmitted).toHaveBeenCalledWith("and then deploy");
    expect(onMessageSteered).not.toHaveBeenCalled();
    expect(
      dispatched.some((a) => a.type === "while_busy_mode_changed"),
    ).toBe(false);
    expect(onWhileBusyModePersistRequested).not.toHaveBeenCalled();
  });

  it("bare /steer and /queue mode flip the persisted mode", () => {
    // Same contract as Ctrl+T in `app-key-bindings.test.ts`: the reducer
    // action moves the live mode, the callback makes it survive a restart.
    // Without the second half the operator sees the confirmation and finds
    // the old mode back on the next launch.
    const steerDispatched: Array<{ type: string; mode?: string }> = [];
    const onSteerPersist = vi.fn();
    handleEditorSubmit(
      "/steer",
      busy("queue"),
      ((a: { type: string; mode?: string }) => steerDispatched.push(a)) as never,
      stubCallbacks({ onWhileBusyModePersistRequested: onSteerPersist }),
    );
    expect(steerDispatched).toContainEqual({
      type: "while_busy_mode_changed",
      mode: "steer",
    });
    expect(onSteerPersist).toHaveBeenCalledWith("steer");

    const queueDispatched: Array<{ type: string; mode?: string }> = [];
    const onQueuePersist = vi.fn();
    handleEditorSubmit(
      "/queue mode",
      busy("steer"),
      ((a: { type: string; mode?: string }) => queueDispatched.push(a)) as never,
      stubCallbacks({ onWhileBusyModePersistRequested: onQueuePersist }),
    );
    expect(queueDispatched).toContainEqual({
      type: "while_busy_mode_changed",
      mode: "queue",
    });
    expect(onQueuePersist).toHaveBeenCalledWith("queue");
  });

  it("bare /queue only lists — looking must not persist a mode change", () => {
    const onWhileBusyModePersistRequested = vi.fn();
    handleEditorSubmit(
      "/queue",
      createInitialTuiState(fakeSession()),
      (() => {}) as never,
      stubCallbacks({ onWhileBusyModePersistRequested }),
    );
    expect(onWhileBusyModePersistRequested).not.toHaveBeenCalled();
  });

  it("/queue clear drops the parked messages without touching the default", () => {
    const onQueueClearRequested = vi.fn();
    const onWhileBusyModePersistRequested = vi.fn();
    handleEditorSubmit(
      "/queue clear",
      busy("steer"),
      (() => {}) as never,
      stubCallbacks({ onQueueClearRequested, onWhileBusyModePersistRequested }),
    );
    expect(onQueueClearRequested).toHaveBeenCalled();
    expect(onWhileBusyModePersistRequested).not.toHaveBeenCalled();
  });

  it("/steer <msg> on an idle session just sends it", () => {
    const dispatched: Array<{ type: string }> = [];
    const onMessageSubmitted = vi.fn();
    const onMessageSteered = vi.fn();
    handleEditorSubmit(
      "/steer go",
      createInitialTuiState(fakeSession()),
      ((a: { type: string }) => dispatched.push(a)) as never,
      stubCallbacks({ onMessageSubmitted, onMessageSteered }),
    );
    expect(onMessageSubmitted).toHaveBeenCalledWith("go");
    expect(onMessageSteered).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === "message_submitted")).toBe(true);
  });
});

