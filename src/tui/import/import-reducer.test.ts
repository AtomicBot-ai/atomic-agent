import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import type { ImportReport } from "../../import/import-report.js";
import { reduceImportAction } from "./import-reducer.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://localhost",
  browserChannel: "chromium",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const REPORT: ImportReport = {
  summary: { migrated: 2, skipped: 1, conflict: 0, error: 0 },
  items: [],
  executed: false,
};

describe("reduceImportAction", () => {
  it("returns null for non-import actions so the root reducer can fall through", () => {
    const state = createInitialTuiState(SESSION);
    expect(reduceImportAction(state, { type: "chat_cleared" })).toBeNull();
  });

  it("patches form fields without leaving configure mode", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_form_field_changed",
      patch: { sourceDir: "/custom/.hermes", limit: "5" },
    });
    expect(next).not.toBeNull();
    expect(next!.importPanel.form.sourceDir).toBe("/custom/.hermes");
    expect(next!.importPanel.form.limit).toBe("5");
    expect(next!.importPanel.mode).toBe("configure");
  });

  it("defaults to the hermes source with sourceType focus", () => {
    const state = createInitialTuiState(SESSION);
    expect(state.importPanel.form.source).toBe("hermes");
    expect(state.importPanel.form.focus).toBe("sourceType");
  });

  it("switches the source to openclaw and resets the default dir + clears secrets", () => {
    const base = createInitialTuiState(SESSION);
    base.importPanel.form.secrets = true;
    base.importPanel.form.focus = "limit";
    const next = reduceImportAction(base, {
      type: "import_source_set",
      source: "openclaw",
    });
    expect(next!.importPanel.form.source).toBe("openclaw");
    expect(next!.importPanel.form.sourceDir).toMatch(/\.openclaw$/);
    expect(next!.importPanel.form.secrets).toBe(false);
    expect(next!.importPanel.form.focus).toBe("sourceType");
  });

  it("is a no-op when switching to the already-active source", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_source_set",
      source: "hermes",
    });
    // Same source -> reducer returns the unchanged state object.
    expect(next).toBe(state);
  });

  it("toggles a boolean field", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_toggled",
      field: "secrets",
    });
    expect(next!.importPanel.form.secrets).toBe(true);
  });

  it("moves focus", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_focus_set",
      focus: "run",
    });
    expect(next!.importPanel.form.focus).toBe("run");
  });

  it("enters running mode on preview_started and clears the notice", () => {
    const base = createInitialTuiState(SESSION);
    base.importPanel.notice = "stale";
    const next = reduceImportAction(base, { type: "import_preview_started" });
    expect(next!.importPanel.mode).toBe("running");
    expect(next!.importPanel.notice).toBeNull();
  });

  it("switches to preview mode with a non-executed report", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_preview_ready",
      report: REPORT,
    });
    expect(next!.importPanel.mode).toBe("preview");
    expect(next!.importPanel.report).toBe(REPORT);
    expect(next!.importPanel.reportExecuted).toBe(false);
  });

  it("switches to done mode with an executed report", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceImportAction(state, {
      type: "import_execute_done",
      report: { ...REPORT, executed: true },
    });
    expect(next!.importPanel.mode).toBe("done");
    expect(next!.importPanel.reportExecuted).toBe(true);
  });

  it("returns to configure with a notice on failure", () => {
    const base = createInitialTuiState(SESSION);
    base.importPanel.mode = "running";
    const next = reduceImportAction(base, {
      type: "import_failed",
      error: "boom",
    });
    expect(next!.importPanel.mode).toBe("configure");
    expect(next!.importPanel.notice).toBe("boom");
  });

  it("resets back to configure and drops the report", () => {
    const base = createInitialTuiState(SESSION);
    base.importPanel.mode = "done";
    base.importPanel.report = REPORT;
    base.importPanel.reportExecuted = true;
    const next = reduceImportAction(base, { type: "import_reset" });
    expect(next!.importPanel.mode).toBe("configure");
    expect(next!.importPanel.report).toBeNull();
    expect(next!.importPanel.reportExecuted).toBe(false);
  });
});
