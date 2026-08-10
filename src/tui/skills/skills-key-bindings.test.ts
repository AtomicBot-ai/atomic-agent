import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import { handleSkillsTabKey } from "./skills-key-bindings.js";
import type {
  HubSkillRow,
  SkillsPanelState,
} from "./skills-panel-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

const HUB_ROWS: readonly HubSkillRow[] = [
  {
    identifier: "anthropics/skills/pdf",
    name: "pdf",
    description: "Work with PDFs",
    version: "1.0.0",
    repo: "anthropics/skills",
    source: "github",
  },
  {
    identifier: "openai/skills/csv",
    name: "csv",
    description: "Work with CSVs",
    version: "2.0.0",
    repo: "openai/skills",
    source: "github",
  },
];

function skillsTabState(panel: Partial<SkillsPanelState> = {}) {
  const initial = createInitialTuiState(SESSION);
  return {
    ...initial,
    uiMode: "debug" as const,
    activeTab: "skills" as const,
    skillsPanel: { ...initial.skillsPanel, ...panel },
  };
}

function makeCtx(panel: Partial<SkillsPanelState> = {}) {
  const dispatch = vi.fn<(action: TuiAction) => void>();
  const callbacks: TuiAppCallbacks = {
    onSkillHubOpen: vi.fn(),
    onSkillHubSearch: vi.fn(),
    onSkillHubRefresh: vi.fn(),
    onSkillHubCardOpen: vi.fn(),
    onSkillHubInstall: vi.fn(),
    onSkillInstallConfirmed: vi.fn(),
    onSkillInstallCancelled: vi.fn(),
    onSkillRemoveRequested: vi.fn(),
    onSkillRemoveConfirmed: vi.fn(),
  } as unknown as TuiAppCallbacks;
  const state = skillsTabState(panel);
  return { dispatch, callbacks, state };
}

describe("handleSkillsTabKey — hub mode", () => {
  it("ignores keys when not on the skills tab in debug mode", () => {
    const ctx = makeCtx();
    const state = { ...ctx.state, activeTab: "chat" as const };
    expect(handleSkillsTabKey("i", emptyKey(), { ...ctx, state })).toBe(false);
  });

  it("opens the hub from list mode on 'i'", () => {
    const ctx = makeCtx({ mode: "list" });
    expect(handleSkillsTabKey("i", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillHubOpen).toHaveBeenCalledTimes(1);
  });

  it("moves the hub cursor with j/k", () => {
    const ctx = makeCtx({ mode: "hub", hubRows: HUB_ROWS });
    expect(handleSkillsTabKey("j", emptyKey(), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "skills_hub_cursor_moved",
      delta: 1,
    });
    expect(handleSkillsTabKey("k", emptyKey(), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "skills_hub_cursor_moved",
      delta: -1,
    });
  });

  it("focuses search on '/' and edits the query on printable keys", () => {
    const editing = makeCtx({
      mode: "hub",
      hubSearchEditing: true,
      hubQuery: "pd",
    });
    expect(handleSkillsTabKey("f", emptyKey(), editing)).toBe(true);
    expect(editing.dispatch).toHaveBeenCalledWith({
      type: "skills_hub_query_changed",
      query: "pdf",
    });

    const focus = makeCtx({ mode: "hub" });
    expect(handleSkillsTabKey("/", emptyKey(), focus)).toBe(true);
    expect(focus.dispatch).toHaveBeenCalledWith({
      type: "skills_hub_search_focus",
      editing: true,
    });
  });

  it("submits the search query on Enter while editing", () => {
    const ctx = makeCtx({
      mode: "hub",
      hubSearchEditing: true,
      hubQuery: "  pdf  ",
    });
    expect(handleSkillsTabKey("", emptyKey({ return: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillHubSearch).toHaveBeenCalledWith("pdf");
  });

  it("opens the pre-install card for the selected hub row on Enter", () => {
    const ctx = makeCtx({ mode: "hub", hubRows: HUB_ROWS, hubCursor: 1 });
    expect(handleSkillsTabKey("", emptyKey({ return: true }), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillHubCardOpen).toHaveBeenCalledWith(HUB_ROWS[1]);
    expect(ctx.callbacks.onSkillHubInstall).not.toHaveBeenCalled();
  });

  it("installs from the card on 'i'/'y'/Enter", () => {
    const card = {
      identifier: "@alice/pdf",
      source: "clawhub" as const,
      name: "pdf",
      repo: "alice",
      description: "pdf",
      version: "1.0.0",
      downloads: 10,
      body: "# pdf",
      bodyError: null,
    };
    const ctx = makeCtx({ mode: "hub", hubCard: card });
    expect(handleSkillsTabKey("i", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillHubInstall).toHaveBeenCalledWith(
      "@alice/pdf",
      "clawhub",
    );
  });

  it("closes the card on 'n'/Esc", () => {
    const card = {
      identifier: "@alice/pdf",
      source: "clawhub" as const,
      name: "pdf",
      repo: "alice",
      description: "pdf",
      version: "1.0.0",
      downloads: 10,
      body: null,
      bodyError: null,
    };
    const ctx = makeCtx({ mode: "hub", hubCard: card });
    expect(handleSkillsTabKey("n", emptyKey(), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "skills_hub_card_closed" });
  });

  it("closes the hub on Esc", () => {
    const ctx = makeCtx({ mode: "hub" });
    expect(handleSkillsTabKey("", emptyKey({ escape: true }), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: "skills_hub_closed" });
  });

  it("re-browses on 'r'", () => {
    const ctx = makeCtx({ mode: "hub" });
    expect(handleSkillsTabKey("r", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillHubRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("handleSkillsTabKey — remove", () => {
  const ROW = {
    name: "pdf",
    description: "Work with PDFs",
    version: "1.0.0",
    source: "global" as const,
    disabled: false,
  };

  it("requests removal of the selected row on 'd' in list mode", () => {
    const ctx = makeCtx({ mode: "list", rows: [ROW], cursor: 0 });
    expect(handleSkillsTabKey("d", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillRemoveRequested).toHaveBeenCalledWith("pdf");
  });

  it("confirms removal on 'y' in the remove-confirm modal", () => {
    const ctx = makeCtx({
      removeConfirm: {
        name: "pdf",
        source: "global",
        isStarter: false,
        submitting: false,
        error: null,
      },
    });
    expect(handleSkillsTabKey("y", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillRemoveConfirmed).toHaveBeenCalledWith("pdf");
  });

  it("closes the remove-confirm modal on 'n'", () => {
    const ctx = makeCtx({
      removeConfirm: {
        name: "pdf",
        source: "global",
        isStarter: true,
        submitting: false,
        error: null,
      },
    });
    expect(handleSkillsTabKey("n", emptyKey(), ctx)).toBe(true);
    expect(ctx.dispatch).toHaveBeenCalledWith({
      type: "skills_remove_confirm_closed",
    });
  });

  it("swallows keys while a removal is submitting", () => {
    const ctx = makeCtx({
      removeConfirm: {
        name: "pdf",
        source: "global",
        isStarter: false,
        submitting: true,
        error: null,
      },
    });
    expect(handleSkillsTabKey("y", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillRemoveConfirmed).not.toHaveBeenCalled();
  });
});

describe("handleSkillsTabKey — install confirm", () => {
  const confirmPanel: Partial<SkillsPanelState> = {
    mode: "hub",
    installConfirm: {
      identifier: "anthropics/skills/pdf",
      verdict: "caution",
      findings: [],
    },
  };

  it("confirms the install on 'y'", () => {
    const ctx = makeCtx(confirmPanel);
    expect(handleSkillsTabKey("y", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillInstallConfirmed).toHaveBeenCalledWith(
      "anthropics/skills/pdf",
    );
  });

  it("cancels the install on 'n'", () => {
    const ctx = makeCtx(confirmPanel);
    expect(handleSkillsTabKey("n", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillInstallCancelled).toHaveBeenCalledWith(
      "anthropics/skills/pdf",
    );
  });

  it("swallows every other key while the modal is open", () => {
    const ctx = makeCtx(confirmPanel);
    expect(handleSkillsTabKey("x", emptyKey(), ctx)).toBe(true);
    expect(ctx.callbacks.onSkillInstallConfirmed).not.toHaveBeenCalled();
    expect(ctx.callbacks.onSkillInstallCancelled).not.toHaveBeenCalled();
  });
});
