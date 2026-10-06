import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { createEmptySessionState, recordTurn, userTurn } from "../../session/index.js";
import { QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import { createRuntimePromptPreview } from "./runtime-prompt-preview.js";
import { SessionNotFoundError } from "../session-not-found-error.js";

describe("pure next-turn prompt preview", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runtime-preview-"));
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", dir);
    resetConfigCache();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetConfigCache();
    await rm(dir, { recursive: true, force: true });
  });

  function fixture() {
    const config = getConfig();
    const session = recordTurn(createEmptySessionState({ id: "existing", workingDir: dir }), userTurn("earlier message"));
    const load = vi.fn((id: string) => id === session.id ? session : null);
    const listForPrompt = vi.fn(() => []);
    let toolName = "first.tool";
    let transport: ToolCallTransport = "grammar";
    const preview = createRuntimePromptPreview(config, {
      workingDir: dir, sessionStore: { load }, profileStore: { listForPrompt },
      capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: dir, hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      effectiveToolDescriptors: () => [{ name: toolName, summary: "live tool", argsSchema: "{}" }],
      getSkillCatalog: () => [], getLiveProfile: () => QWEN_THINK_PROFILE,
      resolveToolTransport: () => transport, resolveCatalogContextWindow: () => 8192,
    });
    return { preview, session, load, listForPrompt, setTool(name: string) { toolName = name; }, setTransport(next: ToolCallTransport) { transport = next; } };
  }

  it("counts a fresh draft without loading or persisting a session", () => {
    const f = fixture();
    const empty = f.preview({ sessionId: null });
    const draft = f.preview({ sessionId: null, userMessage: "a meaningful draft with several words" });
    expect(f.load).not.toHaveBeenCalled();
    expect(draft.text).toContain("a meaningful draft with several words");
    expect(draft.tokens.conversation).toBeGreaterThan(empty.tokens.conversation);
  });

  it("adds draft to a local copy of the stored transcript and rejects missing ids", () => {
    const f = fixture();
    const before = structuredClone(f.session);
    const built = f.preview({ sessionId: f.session.id, userMessage: "new draft" });
    expect(built.text).toContain("earlier message");
    expect(built.text).toContain("new draft");
    expect(f.session).toEqual(before);
    expect(() => f.preview({ sessionId: "missing" })).toThrow(SessionNotFoundError);
  });

  it("reads live tools and transport for each preview", () => {
    const f = fixture();
    expect(f.preview({ sessionId: null }).text).toContain("first.tool");
    f.setTool("replacement.tool");
    f.setTransport("native_tools");
    const built = f.preview({ sessionId: null });
    expect(built.text).toContain("replacement.tool");
    expect(built.text).not.toContain("first.tool");
    expect(built.text.endsWith("<think>")).toBe(false);
  });
});
