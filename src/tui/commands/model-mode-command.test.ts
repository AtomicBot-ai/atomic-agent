import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import { setModelModeInConfig } from "../../config/model-mode-commands.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";
import { runSlashCommand } from "../submit-handler.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiAppCallbacks } from "../tui-app.js";

describe("model mode command persistence", () => {
  let dir: string;
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.ATOMIC_AGENT_STATE_DIR;
    dir = mkdtempSync(join(tmpdir(), "atomic-model-mode-"));
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    resetConfigCache();
    writeUserConfigFileSync(getUserConfigPath(dir), { ...USER_CONFIG_DEFAULTS, llm: {
      activeTextProvider: "remote", activeEmbeddingProvider: "remote", toolTransport: "auto",
      providers: [{ id: "remote", kind: "openrouter", defaultChatModel: "large", userModels: [{ id: "large", kind: "chat", contextWindow: 64000 }] }, { id: "other", kind: "llama-server" }],
    } });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = previous;
    resetConfigCache(); rmSync(dir, { recursive: true, force: true });
  });
  it("parses without writing and switches both ways through the real submit route", () => {
    const before = readFileSync(getUserConfigPath(dir), "utf8");
    expect(dispatchSlashCommand("/llm model-mode cloud").modelModeCommand).toEqual({ mode: "cloud" });
    expect(readFileSync(getUserConfigPath(dir), "utf8")).toBe(before);
    const dispatch = vi.fn();
    const callbacks = {} as TuiAppCallbacks;
    const state = createInitialTuiState({
      sessionId: null, workingDir: dir, llamaUrl: "http://localhost:8080",
      browserChannel: "chrome", browserHeadless: true, approvalLevel: 1,
      maxSteps: 10, completionMaxTokens: 1024, skillCount: 0, localBackendConfigured: false,
    });
    runSlashCommand("/llm model-mode cloud", state, dispatch, callbacks);
    expect(getConfig().llm!.providers[0]!.modelMode).toBe("cloud");
    resetConfigCache();
    expect(getConfig().llm!.providers[0]!.modelMode).toBe("cloud");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "system_message", text: expect.stringContaining("next turn") }));
    runSlashCommand("/llm model-mode local remote large", state, dispatch, callbacks);
    expect(getConfig().llm!.providers[0]!.modelModes).toEqual({ large: "local" });
    expect(getConfig().llm!.providers[0]!.userModels?.[0]?.contextWindow).toBe(64000);
    runSlashCommand("/llm model-mode inherit remote large", state, dispatch, callbacks);
    expect(getConfig().llm!.providers[0]!.modelModes).toBeUndefined();
    runSlashCommand("/llm model-mode local", state, dispatch, callbacks);
    expect(getConfig().llm!.providers[0]!.modelMode).toBe("local");
    expect(getConfig().llm!.providers[1]!.modelMode).toBeUndefined();
  });
  it("rejects invalid/unknown targets without altering the configuration", () => {
    const before = readFileSync(getUserConfigPath(dir), "utf8");
    expect(dispatchSlashCommand("/llm model-mode auto").systemMessage).toContain("usage:");
    expect(() => setModelModeInConfig({ providerId: "missing", mode: "cloud" })).toThrow(/not configured/);
    expect(readFileSync(getUserConfigPath(dir), "utf8")).toBe(before);
  });
});
