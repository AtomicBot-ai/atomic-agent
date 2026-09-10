import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { SessionStore } from "../../session/index.js";
import { makeTuiEventBus } from "../make-event-bus.js";
import type { OnboardingImportPlan } from "../onboarding/import-step.js";
import type { TuiAction } from "../tui-action.js";
import { ImportOrchestrator } from "./import-orchestrator.js";
import type { ImportFormState } from "./import-panel-state.js";
import {
  createInitialImportFormState,
  type ImportFormState,
} from "./import-panel-state.js";

interface Emitted {
  type: string;
  [key: string]: unknown;
}
import {
  createInitialImportFormState,
  type ImportFormState,
} from "./import-panel-state.js";

function makeBus() {
  const actions: Emitted[] = [];
  return {
    actions,
    bus: {
      subscribe: () => () => {},
      emit: (action: unknown) => {
        actions.push(action as Emitted);
      },
    },
  };
}

function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

/** `count` Claude Code transcripts, one user message each. */
function seedClaudeCode(dir: string, count: number): void {
  const projectDir = join(dir, "projects", "-work");
  mkdirSync(projectDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    writeFileSync(
      join(projectDir, `s${String(i).padStart(3, "0")}.jsonl`),
      line({
        type: "user",
        cwd: "/work",
        timestamp: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
        message: { role: "user", content: `message ${i}` },
      }),
    );
  }
}

function seedCodex(dir: string): void {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(
    join(dir, "sessions", "rollout-x.jsonl"),
    [
      line({
        timestamp: "2026-08-02T10:00:00Z",
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/work" },
      }),
      line({
        timestamp: "2026-08-02T10:00:01Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
    ].join(""),
  );
}

describe("ImportOrchestrator", () => {
  let root: string;
  let stateDir: string;
  let sessionStore: SessionStore;
  let runtime: AgentRuntime;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "import-orch-"));
    stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    sessionStore = new SessionStore({
      dbFile: join(stateDir, "sessions.sqlite"),
    });
    runtime = {
      sessionStore,
      taskStore: { list: () => [], create: () => ({ id: "t" }) },
      notesStore: { list: () => [], store: () => undefined },
      config: {
        paths: {
          stateDir,
          userConfigFile: join(stateDir, "config.json"),
          globalSkillsDir: join(stateDir, "skills"),
        },
        tasks: { maxAttempts: 3 },
      },
    } as unknown as AgentRuntime;
  });

  afterEach(() => {
    sessionStore.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  it("onboarding imports every Claude Code session, well past the old cap of 100", async () => {
    const dir = join(root, ".claude");
    seedClaudeCode(dir, 130);
    const plan: OnboardingImportPlan = {
      agents: [{ id: "claude-code", label: "Claude Code", dir, enabled: true }],
      options: [
        {
          agent: "claude-code",
          agentLabel: "Claude Code",
          option: "sessions",
          label: "Sessions",
          description: "",
          secret: false,
          enabled: true,
        },
      ],
    };
    const { actions, bus } = makeBus();
    await new ImportOrchestrator(runtime, bus).runOnboarding(plan, true);

    const done = actions.find((a) => a.type === "onboarding_import_report");
    expect(done).toBeDefined();
    const report = done!.report as {
      summary: { migrated: number };
      items: unknown[];
    };
    expect(report.summary.migrated).toBe(130);
    expect(report.items).toHaveLength(130);
    expect(sessionStore.load("claude-code:s000")).not.toBeNull();
    expect(sessionStore.load("claude-code:s129")).not.toBeNull();
  });

  it("previews a Claude Code import from the tab form", async () => {
    const dir = join(root, ".claude");
    seedClaudeCode(dir, 2);
    const form: ImportFormState = {
      ...createInitialImportFormState(),
      source: "claude-code",
      sourceDir: dir,
      skills: false,
      memory: false,
      mcp: false,
    };
    const { actions, bus } = makeBus();
    new ImportOrchestrator(runtime, bus).preview(form);
    await vi.waitFor(() => {
      expect(actions.some((a) => a.type === "import_preview_ready")).toBe(true);
    });
    const ready = actions.find((a) => a.type === "import_preview_ready")!;
    const report = ready.report as {
      summary: { migrated: number };
      executed: boolean;
    };
    expect(report.executed).toBe(false);
    expect(report.summary.migrated).toBe(2);
    expect(sessionStore.load("claude-code:s000")).toBeNull();
  });

  it("executes a Codex import from the tab form", async () => {
    const dir = join(root, ".codex");
    seedCodex(dir);
    const form: ImportFormState = {
      ...createInitialImportFormState(),
      source: "codex",
      sourceDir: dir,
      skills: false,
      memory: false,
    };
    const { actions, bus } = makeBus();
    new ImportOrchestrator(runtime, bus).execute(form);
    await vi.waitFor(() => {
      expect(actions.some((a) => a.type === "import_execute_done")).toBe(true);
    });
    expect(sessionStore.load("codex:sess-1")?.turns).toHaveLength(1);
  });

  it("names the rows to enable when the form has nothing ticked", async () => {
    const form: ImportFormState = {
      ...createInitialImportFormState(),
      source: "codex",
      skills: false,
      memory: false,
      sessions: false,
    };
    const { actions, bus } = makeBus();
    new ImportOrchestrator(runtime, bus).preview(form);
    await vi.waitFor(() => {
      expect(actions.some((a) => a.type === "import_failed")).toBe(true);
    });
    expect(actions.find((a) => a.type === "import_failed")?.error).toBe(
      "nothing selected to import — enable skills, memory, sessions or secrets",
    );
  });
});

/**
 * An empty source dir is a complete import run: the importer reports
 * every domain as skipped (`no state.db at …`), writes nothing, and
 * still reaches the completion path — which is the path under test.
 */
function stubRuntime(tmp: string): AgentRuntime {
  return {
    sessionStore: {},
    taskStore: {},
    config: {
      paths: { stateDir: join(tmp, "state") },
      tasks: { maxAttempts: 1 },
    },
  } as unknown as AgentRuntime;
}

function form(
  overrides: Partial<ImportFormState>,
  sourceDir: string,
): ImportFormState {
  return {
    source: "hermes",
    sourceDir,
    sessions: true,
    cron: false,
    secrets: false,
    overwrite: false,
    limit: "",
    focus: "sessions",
    ...overrides,
  };
}

function plan(dir: string, option: string): OnboardingImportPlan {
  return {
    agents: [{ id: "hermes", label: "Hermes", dir, enabled: true }],
    options: [
      {
        agent: "hermes",
        agentLabel: "Hermes",
        option,
        label: option,
        description: "",
        secret: false,
        enabled: true,
      },
    ],
  };
}

async function settled(
  actions: TuiAction[],
  type: TuiAction["type"],
): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (actions.some((a) => a.type === type)) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`no ${type} action emitted`);
}

describe("ImportOrchestrator refreshSessions", () => {
  let tmp: string;
  let actions: TuiAction[];
  let refreshSessions: ReturnType<typeof vi.fn>;
  let orchestrator: ImportOrchestrator;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-import-"));
    actions = [];
    refreshSessions = vi.fn();
    const bus = makeTuiEventBus();
    bus.subscribe((a) => actions.push(a));
    orchestrator = new ImportOrchestrator(stubRuntime(tmp), bus, {
      refreshSessions,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("refreshes the rail after an executed tab import that included sessions", async () => {
    orchestrator.execute(form({}, tmp));
    await settled(actions, "import_execute_done");
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("does not refresh after a preview", async () => {
    orchestrator.preview(form({}, tmp));
    await settled(actions, "import_preview_ready");
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("does not refresh when sessions were not part of the run", async () => {
    orchestrator.execute(form({ sessions: false, cron: true }, tmp));
    await settled(actions, "import_execute_done");
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("refreshes the rail after an executed onboarding import with sessions", async () => {
    await orchestrator.runOnboarding(plan(tmp, "sessions"), true);
    expect(actions.some((a) => a.type === "onboarding_import_report")).toBe(
      true,
    );
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("does not refresh after an onboarding preview", async () => {
    await orchestrator.runOnboarding(plan(tmp, "sessions"), false);
    expect(refreshSessions).not.toHaveBeenCalled();
  });
});
