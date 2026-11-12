import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import {
  USER_CONFIG_DEFAULTS,
  type UserConfigFile,
} from "../../config/config-schema.js";
import { getConfig } from "../../config/index.js";
import type { TuiAction } from "../tui-action.js";
import { RunModeOrchestrator } from "./run-mode-orchestrator.js";

/**
 * ATO-1431: a subscription CLI on the worker leg is warned about, not
 * refused, and every other worker kind switches exactly as before.
 */
const CODEX_WORKER: UserConfigFile["llm"] = {
  activeTextProvider: "openrouter",
  activeEmbeddingProvider: "openrouter",
  toolTransport: "auto",
  providers: [
    { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
    {
      id: "codex",
      kind: "subscription-cli",
      defaultChatModel: "gpt-5",
      subscriptionCli: { cli: "codex" },
    },
  ],
};

const LOCAL_WORKER: UserConfigFile["llm"] = {
  activeTextProvider: "openrouter",
  activeEmbeddingProvider: "local-llama",
  toolTransport: "auto",
  providers: [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
  ],
};

const API_KEY_WORKER: UserConfigFile["llm"] = {
  activeTextProvider: "openrouter",
  activeEmbeddingProvider: "openrouter",
  toolTransport: "auto",
  providers: [
    { id: "openrouter", kind: "openrouter", defaultChatModel: "gpt" },
    { id: "groq", kind: "openai-compatible", defaultChatModel: "llama-3.3" },
  ],
};

const WARNING = /Workers on a subscription CLI: every task uses your subscription limit, and there is no live progress\./;

describe("RunModeOrchestrator.setMode with a subscription-CLI worker leg", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-run-mode-cli-worker-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  function seed(llm: UserConfigFile["llm"]) {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      ...(llm ? { llm } : {}),
    });
    resetConfigCache();
  }

  function harness() {
    const actions: TuiAction[] = [];
    const deps = {
      runtime: {
        providerRegistry: { setActive: vi.fn(async () => ({}) as never) } as never,
      },
      bus: { emit: (action: TuiAction) => actions.push(action) },
      providers: {
        refresh: vi.fn(),
        ensureInlineModels: vi.fn(async () => {}),
      },
      localModels: {
        startDaemon: vi.fn(async () => true),
        adoptDaemonForRoute: vi.fn(() => false),
      },
    };
    return { actions, orchestrator: new RunModeOrchestrator(deps) };
  }

  function noticeTexts(actions: TuiAction[]): string[] {
    return actions.flatMap((a) =>
      a.type === "composer_notice" && a.text !== null ? [a.text] : [],
    );
  }

  it("switches to fusion with a Codex worker and warns about the cost", async () => {
    seed(CODEX_WORKER);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    // Not blocked: the mode and both legs are written.
    expect(getConfig().llm?.runMode).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter", workerProvider: "codex" },
    });
    expect(noticeTexts(app.actions)).toEqual([
      expect.stringMatching(WARNING),
    ]);
    expect(
      app.actions.some(
        (a) => a.type === "runtime_info" && /^fusion: Workers on a subscription CLI/.test(a.line),
      ),
    ).toBe(true);
  });

  it("leaves a local worker leg unchanged: no warning", async () => {
    seed(LOCAL_WORKER);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.fusion?.workerProvider).toBe("local-llama");
    expect(noticeTexts(app.actions)).toEqual([]);
  });

  it("leaves an API-key worker leg unchanged: no warning", async () => {
    seed(API_KEY_WORKER);
    const app = harness();
    await app.orchestrator.setMode("fusion");
    expect(getConfig().llm?.runMode?.fusion?.workerProvider).toBe("groq");
    expect(noticeTexts(app.actions)).toEqual([]);
  });

  it("does not warn when the subscription CLI is the orchestrator, not the worker", async () => {
    seed({
      ...CODEX_WORKER,
      providers: [...CODEX_WORKER!.providers, LOCAL_WORKER!.providers[0]!],
    });
    const app = harness();
    await app.orchestrator.setMode("fusion", {
      fusion: { orchestratorProvider: "codex", workerProvider: "local-llama" },
    });
    expect(getConfig().llm?.runMode?.fusion?.orchestratorProvider).toBe("codex");
    expect(noticeTexts(app.actions)).toEqual([]);
  });
});
