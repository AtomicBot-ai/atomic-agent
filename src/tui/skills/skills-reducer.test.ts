import { describe, expect, it } from "vitest";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { reduceSkillsAction } from "./skills-reducer.js";
import type { HubSkillRow, SkillSummaryRow } from "./skills-panel-state.js";

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

const ROWS: readonly SkillSummaryRow[] = [
  {
    name: "alpha",
    description: "Skill alpha",
    version: "0.1.0",
    source: "global",
    disabled: false,
  },
  {
    name: "beta",
    description: "Skill beta",
    version: "0.2.0",
    source: "global",
    disabled: true,
  },
  {
    name: "gamma",
    description: "Skill gamma",
    version: "0.3.0",
    source: "project",
    disabled: false,
  },
];

describe("reduceSkillsAction", () => {
  it("returns null for non-skills actions so the root reducer can fall through", () => {
    const state = createInitialTuiState(SESSION);
    expect(reduceSkillsAction(state, { type: "chat_cleared" })).toBeNull();
  });

  it("folds skills_refreshed into rows + lastRefreshedAt", () => {
    const state = createInitialTuiState(SESSION);
    const next = reduceSkillsAction(state, {
      type: "skills_refreshed",
      rows: ROWS,
      at: 42,
    });
    expect(next).not.toBeNull();
    expect(next!.skillsPanel.rows).toHaveLength(3);
    expect(next!.skillsPanel.lastRefreshedAt).toBe(42);
    expect(next!.skillsPanel.loading).toBe(false);
  });

  it("clamps cursor_moved to the row range", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_refreshed",
      rows: ROWS,
      at: 0,
    })!;
    state = reduceSkillsAction(state, {
      type: "skills_cursor_moved",
      delta: 99,
    })!;
    expect(state.skillsPanel.cursor).toBe(2);
    state = reduceSkillsAction(state, {
      type: "skills_cursor_moved",
      delta: -99,
    })!;
    expect(state.skillsPanel.cursor).toBe(0);
  });

  it("opens and closes the detail view", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_detail_opened",
      name: "alpha",
      body: "alpha body",
    })!;
    expect(state.skillsPanel.mode).toBe("detail");
    expect(state.skillsPanel.detailName).toBe("alpha");
    expect(state.skillsPanel.detailBody).toBe("alpha body");
    state = reduceSkillsAction(state, { type: "skills_detail_closed" })!;
    expect(state.skillsPanel.mode).toBe("list");
    expect(state.skillsPanel.detailName).toBeNull();
    expect(state.skillsPanel.detailBody).toBeNull();
  });

  it("optimistically flips the disabled flag on the matching row", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_refreshed",
      rows: ROWS,
      at: 0,
    })!;
    state = reduceSkillsAction(state, {
      type: "skills_toggle_settled",
      name: "alpha",
      disabled: true,
    })!;
    const alpha = state.skillsPanel.rows.find((r) => r.name === "alpha");
    expect(alpha?.disabled).toBe(true);
  });

  it("cycles the filter via skills_filter_cycled", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.skillsPanel.filterStatus).toBe("all");
    state = reduceSkillsAction(state, {
      type: "skills_filter_cycled",
      direction: 1,
    })!;
    expect(state.skillsPanel.filterStatus).toBe("enabled");
    state = reduceSkillsAction(state, {
      type: "skills_filter_cycled",
      direction: 1,
    })!;
    expect(state.skillsPanel.filterStatus).toBe("disabled");
    state = reduceSkillsAction(state, {
      type: "skills_filter_cycled",
      direction: 1,
    })!;
    expect(state.skillsPanel.filterStatus).toBe("all");
  });

  it("toggles auto-refresh", () => {
    let state = createInitialTuiState(SESSION);
    expect(state.skillsPanel.autoRefresh).toBe(true);
    state = reduceSkillsAction(state, {
      type: "skills_auto_refresh_toggled",
    })!;
    expect(state.skillsPanel.autoRefresh).toBe(false);
  });

  it("captures errors via skills_refresh_failed and clears via skills_error_set", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_refresh_failed",
      error: "boom",
    })!;
    expect(state.skillsPanel.lastError).toBe("boom");
    expect(state.skillsPanel.loading).toBe(false);
    state = reduceSkillsAction(state, {
      type: "skills_error_set",
      error: null,
    })!;
    expect(state.skillsPanel.lastError).toBeNull();
  });

  const HUB_ROWS: readonly HubSkillRow[] = [
    {
      identifier: "anthropics/skills/pdf",
      name: "pdf",
      description: "Work with PDFs",
      version: "1.0.0",
      repo: "anthropics/skills",
    },
    {
      identifier: "openai/skills/csv",
      name: "csv",
      description: "Work with CSVs",
      version: "2.0.0",
      repo: "openai/skills",
    },
  ];

  it("switches into hub mode and resets the hub cursor", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, { type: "skills_hub_opened" })!;
    expect(state.skillsPanel.mode).toBe("hub");
    expect(state.skillsPanel.hubCursor).toBe(0);
    expect(state.skillsPanel.hubSearchEditing).toBe(false);
  });

  it("folds hub results and clamps the hub cursor down to the new range", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, { type: "skills_hub_opened" })!;
    state = reduceSkillsAction(state, {
      type: "skills_hub_results",
      rows: HUB_ROWS,
      error: null,
    })!;
    state = reduceSkillsAction(state, {
      type: "skills_hub_cursor_moved",
      delta: 1,
    })!;
    expect(state.skillsPanel.hubCursor).toBe(1);
    // A narrower result set re-clamps the cursor into range.
    state = reduceSkillsAction(state, {
      type: "skills_hub_results",
      rows: [HUB_ROWS[0]!],
      error: null,
    })!;
    expect(state.skillsPanel.hubRows).toHaveLength(1);
    expect(state.skillsPanel.hubLoading).toBe(false);
    expect(state.skillsPanel.hubCursor).toBe(0);
  });

  it("tracks the hub search query and edit focus", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_hub_search_focus",
      editing: true,
    })!;
    expect(state.skillsPanel.hubSearchEditing).toBe(true);
    state = reduceSkillsAction(state, {
      type: "skills_hub_query_changed",
      query: "pdf",
    })!;
    expect(state.skillsPanel.hubQuery).toBe("pdf");
  });

  it("opens and closes the install confirmation modal", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_install_confirm_opened",
      confirm: {
        identifier: "anthropics/skills/pdf",
        verdict: "caution",
        findings: [],
      },
    })!;
    expect(state.skillsPanel.installConfirm?.identifier).toBe(
      "anthropics/skills/pdf",
    );
    expect(state.skillsPanel.installing).toBe(false);
    state = reduceSkillsAction(state, {
      type: "skills_install_confirm_closed",
    })!;
    expect(state.skillsPanel.installConfirm).toBeNull();
  });

  it("closes hub mode and clears the install confirmation", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, { type: "skills_hub_opened" })!;
    state = reduceSkillsAction(state, {
      type: "skills_install_confirm_opened",
      confirm: {
        identifier: "openai/skills/csv",
        verdict: "dangerous",
        findings: [],
      },
    })!;
    state = reduceSkillsAction(state, { type: "skills_hub_closed" })!;
    expect(state.skillsPanel.mode).toBe("list");
    expect(state.skillsPanel.installConfirm).toBeNull();
  });

  it("opens, flags submitting, fails, and closes the remove confirmation", () => {
    let state = createInitialTuiState(SESSION);
    state = reduceSkillsAction(state, {
      type: "skills_remove_confirm_opened",
      confirm: {
        name: "alpha",
        source: "global",
        isStarter: true,
        submitting: false,
        error: null,
      },
    })!;
    expect(state.skillsPanel.removeConfirm?.name).toBe("alpha");
    expect(state.skillsPanel.removeConfirm?.isStarter).toBe(true);

    state = reduceSkillsAction(state, { type: "skills_remove_submitting" })!;
    expect(state.skillsPanel.removeConfirm?.submitting).toBe(true);

    state = reduceSkillsAction(state, {
      type: "skills_remove_failed",
      error: "boom",
    })!;
    expect(state.skillsPanel.removeConfirm?.submitting).toBe(false);
    expect(state.skillsPanel.removeConfirm?.error).toBe("boom");

    state = reduceSkillsAction(state, {
      type: "skills_remove_confirm_closed",
    })!;
    expect(state.skillsPanel.removeConfirm).toBeNull();
  });
});
