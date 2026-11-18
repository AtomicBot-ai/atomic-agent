import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { createEmptySessionState, recordTurn, userTurn } from "../../session/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../../llm/model-profile.js";
import type { ResolvedModelMode } from "../../llm/model-mode.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import { buildPrompt } from "../../prompt/build-prompt.js";
import { buildRuntimePromptInput } from "./runtime-prompt-preview.js";

/**
 * ATO-1678: the runtime prompt input (manual `/compact`, background
 * compaction, the HTTP preview) budgets a local native-tools link's
 * `tools` array as the real step does, not only a cloud link's.
 */
describe("buildRuntimePromptInput tool schemas (ATO-1678)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runtime-preview-schema-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  });

  function input(transport: ToolCallTransport, mode: "local" | "cloud") {
    const session = recordTurn(createEmptySessionState({ id: "s", workingDir: dir }), userTurn("hello"));
    const modelMode: ResolvedModelMode = { mode, source: "provider", providerId: "p", modelId: "m" };
    const resolveToolSchemaTokens = vi.fn(() => 5_000);
    const built = buildRuntimePromptInput(getConfig(), {
      workingDir: dir, sessionStore: { load: () => null }, profileStore: { listForPrompt: () => [] },
      capabilities: { platform: "win32", arch: "x64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      effectiveToolDescriptors: () => [{ name: "reply", summary: "Answer.", argsSchema: "{ text: string }" }],
      getSkillCatalog: () => [], getLiveProfile: () => PLAIN_INSTRUCT_PROFILE,
      resolveToolTransport: () => transport, resolveCatalogContextWindow: () => 32_768,
      resolveModelMode: () => modelMode, resolveToolSchemaTokens,
    }, session);
    return { built, resolveToolSchemaTokens };
  }

  it("passes the schemas for a local native-tools link", () => {
    const { built } = input("native_tools", "local");
    expect(built.toolSchemaTokens).toBe(5_000);
    expect(buildPrompt(built).tokens.toolSchema).toBe(5_000);
  });

  it("still passes them for a cloud native-tools link", () => {
    expect(input("native_tools", "cloud").built.toolSchemaTokens).toBe(5_000);
  });

  it("passes none for a grammar link", () => {
    const { built, resolveToolSchemaTokens } = input("grammar", "local");
    expect(built.toolSchemaTokens).toBeUndefined();
    expect(resolveToolSchemaTokens).not.toHaveBeenCalled();
  });
});
