import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { makeTuiEventBus } from "../make-event-bus.js";
import type { OnboardingImportPlan } from "../onboarding/import-step.js";
import type { TuiAction } from "../tui-action.js";
import { ImportOrchestrator } from "./import-orchestrator.js";
import type { ImportFormState } from "./import-panel-state.js";

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

function form(overrides: Partial<ImportFormState>, sourceDir: string): ImportFormState {
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

async function settled(actions: TuiAction[], type: TuiAction["type"]): Promise<void> {
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
    orchestrator = new ImportOrchestrator(stubRuntime(tmp), bus, { refreshSessions });
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
    expect(actions.some((a) => a.type === "onboarding_import_report")).toBe(true);
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it("does not refresh after an onboarding preview", async () => {
    await orchestrator.runOnboarding(plan(tmp, "sessions"), false);
    expect(refreshSessions).not.toHaveBeenCalled();
  });
});
