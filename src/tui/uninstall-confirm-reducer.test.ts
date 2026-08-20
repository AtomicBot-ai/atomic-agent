import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { createInitialTuiState, type TuiState } from "./tui-state.js";
import { dispatchSlashCommand } from "./commands/slash-command-handler.js";

const SESSION = {
  sessionId: "s-1",
  workingDir: "/tmp",
  model: "test-model",
} as unknown as Parameters<typeof createInitialTuiState>[0];

function initial(): TuiState {
  return createInitialTuiState(SESSION, 200);
}

function opened(includeState = false): TuiState {
  return reduceTuiState(initial(), {
    type: "uninstall_confirm_opened",
    preview: "would remove: /x",
    includeState,
  });
}

describe("/uninstall dispatch", () => {
  it("asks for the confirmation overlay and removes nothing itself", () => {
    const result = dispatchSlashCommand("/uninstall");
    expect(result.triggerUninstall).toBe(true);
    expect(result.actions).toHaveLength(0);
    expect(result.forwardAsMessage).toBe(false);
  });

  it("leaves the flag off for every other command", () => {
    expect(dispatchSlashCommand("/help").triggerUninstall).toBe(false);
    expect(dispatchSlashCommand("/quit").triggerUninstall).toBe(false);
  });
});

describe("uninstall confirm reducer", () => {
  it("starts closed", () => {
    expect(initial().uninstallConfirm).toBeNull();
  });

  it("opens with the state scope off by default", () => {
    const state = opened();
    expect(state.uninstallConfirm?.includeState).toBe(false);
    expect(state.uninstallConfirm?.submitting).toBe(false);
    expect(state.uninstallConfirm?.done).toBeNull();
  });

  it("toggles the state scope and re-previews", () => {
    const state = reduceTuiState(opened(), {
      type: "uninstall_confirm_state_toggled",
      preview: "would remove: /x and state",
      includeState: true,
    });
    expect(state.uninstallConfirm?.includeState).toBe(true);
    expect(state.uninstallConfirm?.preview).toContain("state");
  });

  it("refuses to change the plan once the removal is in flight", () => {
    const submitting = reduceTuiState(opened(), {
      type: "uninstall_confirm_submitting",
    });
    const after = reduceTuiState(submitting, {
      type: "uninstall_confirm_state_toggled",
      preview: "different plan",
      includeState: true,
    });
    expect(after.uninstallConfirm?.includeState).toBe(false);
    expect(after.uninstallConfirm?.preview).toBe("would remove: /x");
  });

  it("records the outcome and clears the submitting flag", () => {
    const done = reduceTuiState(
      reduceTuiState(opened(), { type: "uninstall_confirm_submitting" }),
      { type: "uninstall_confirm_done", result: "removed /x" },
    );
    expect(done.uninstallConfirm?.done).toBe("removed /x");
    expect(done.uninstallConfirm?.submitting).toBe(false);
  });

  it("keeps the dialog open on failure so the error is readable", () => {
    const failed = reduceTuiState(
      reduceTuiState(opened(), { type: "uninstall_confirm_submitting" }),
      { type: "uninstall_confirm_failed", message: "EACCES" },
    );
    expect(failed.uninstallConfirm).not.toBeNull();
    expect(failed.uninstallConfirm?.error).toBe("EACCES");
    expect(failed.uninstallConfirm?.submitting).toBe(false);
  });

  it("closes on cancel", () => {
    const closed = reduceTuiState(opened(), {
      type: "uninstall_confirm_closed",
    });
    expect(closed.uninstallConfirm).toBeNull();
  });

  it("ignores stray progress actions when no dialog is open", () => {
    const state = initial();
    for (const action of [
      { type: "uninstall_confirm_submitting" },
      { type: "uninstall_confirm_done", result: "x" },
      { type: "uninstall_confirm_failed", message: "x" },
    ] as const) {
      expect(reduceTuiState(state, action).uninstallConfirm).toBeNull();
    }
  });
});
