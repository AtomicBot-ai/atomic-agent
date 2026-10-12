import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig, resetConfigCache } from "../config/index.js";
import { setSkillDisabled } from "../config/skill-policy-commands.js";
import { createWorkspaceLoader } from "../runtime/session-workspace.js";
import { createRuntimePromptPreview } from "../runtime/composition/runtime-prompt-preview.js";
import { createEmptySessionState } from "../session/session-state.js";
import { reconcileCloudSkills } from "../session/workspace-context.js";
import { compactionBoundaryHash } from "../session/session-compaction.js";
import { SessionStore } from "../session/session-store.js";
import { userTurn, assistantReplyTurn } from "../session/conversation-turn.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { buildSkillViewTool } from "../tools/skill/skill-view.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { fakeAnswer, fakeProvider } from "../llm/provider/fake-provider.fixture.js";
import { OpenAiHttpError } from "../llm/provider/openai/openai-http.js";
import { captureModelModePolicy } from "../llm/model-mode.js";
import { ProviderFallbackChain } from "../llm/fallback/index.js";
import { DEFAULT_FALLBACK_TIMING } from "../llm/fallback/fallback-config.js";
import { createFallbackCompleter, createFallbackStreamer } from "../runtime/llm-fallback-seam.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import { buildPrompt, type BuildPromptInput } from "../prompt/build-prompt.js";
import { executeStep } from "./step-executor.js";
import { prepareStepInference } from "./step/step-inference.js";
import type { StepContext, StepDependencies } from "./step/step-contract.js";
import { AgentLoop } from "./agent-loop.js";

const cloud = { mode: "cloud" as const, source: "provider" as const, providerId: "cloud", modelId: "big" };
const capabilities = { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/boot", hasClipboard: false, hasWmctrl: false, hasNotifications: false } as const;

describe("cloud session workspace integration", () => {
  let base: string; let a: string; let b: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "cloud-workspace-"))); a = join(base, "a"); b = join(base, "b");
    vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(base, "state")); resetConfigCache();
    for (const [dir, marker] of [[a, "ALPHA"], [b, "BETA"]]) {
      mkdirSync(join(dir!, ".agents/skills/guide"), { recursive: true });
      writeFileSync(join(dir!, "AGENTS.md"), `${marker} RULE`);
      writeFileSync(join(dir!, ".agents/skills/guide/SKILL.md"), `---\nname: guide\ndescription: ${marker} GUIDE\n---\n${marker} BODY`);
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); rmSync(base, { recursive: true, force: true }); });
  function context(dir: string): StepContext {
    const session = createEmptySessionState({ id: dir, workingDir: dir }); session.turns = [userTurn("inspect")];
    return { session, stepIndex: 0, signal: new AbortController().signal, toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, skillCatalog: [], capabilities };
  }
  function deps(): StepDependencies {
    const registry = new ToolRegistry(); registry.register(buildSkillViewTool(new SkillRegistry({ globalDir: getConfig().paths.globalSkillsDir, projectDir: null })));
    return { registry, llmComplete: async () => ({ ...fakeAnswer("cloud"), toolCalls: [{ function: { name: "skill__view", arguments: '{"name":"guide"}' } }] }),
      slotManager: new SlotManager(1), grammar: "", profile: PLAIN_INSTRUCT_PROFILE, toolTransport: "native_tools", toolCallAdapter: null,
      supportsSlotAffinity: false, modelMode: cloud, contextWindow: 200000, profileWindowApplies: false, prepareWorkspace: createWorkspaceLoader(getConfig()) };
  }

  it("keeps concurrent A/B requests and dispatched skill bodies in their own workspace", async () => {
    const ca = context(a); const cb = context(b); const dependencies = deps();
    const [ra, rb] = await Promise.all([executeStep(ca, dependencies), executeStep(cb, dependencies)]);
    expect(ra.nextSession.cloudLoadedSkills?.[0]?.body).toContain("ALPHA BODY");
    expect(rb.nextSession.cloudLoadedSkills?.[0]?.body).toContain("BETA BODY");
    expect(ra.nextSession.loadedSkills).toEqual([]); expect(rb.nextSession.loadedSkills).toEqual([]);
    expect(prepareStepInference(ca, dependencies).prompt.text).not.toContain("BETA");
    expect(prepareStepInference(cb, dependencies).prompt.text).not.toContain("ALPHA");
    expect(capabilities.workingDir).toBe("/boot");
  });

  it.each([false, true])("prepares first local→cloud fallback before sending (stream=%s)", async stream => {
    const ctx = context(b);
    const policy = captureModelModePolicy({ activeTextProvider: "local", activeEmbeddingProvider: "local", toolTransport: "auto",
      providers: [{ id: "local", kind: "openrouter", modelMode: "local" }, { id: "cloud", kind: "openrouter", modelMode: "cloud" }] });
    const primary = fakeProvider("local", "native_tools", async request => {
      expect(request.prompt).not.toContain("BETA RULE"); throw new OpenAiHttpError("down", 503, "down", false);
    });
    const secondary = fakeProvider("cloud", "native_tools", async request => {
      expect(request.prompt).toContain("BETA RULE"); expect(request.prompt).toContain("BETA GUIDE");
      expect(request.prompt).not.toContain("ALPHA"); expect(request.prompt).not.toContain("/boot");
      return { ...fakeAnswer("cloud"), toolCalls: [{ function: { name: "skill__view", arguments: '{"name":"guide"}' } }] };
    });
    const seam = { fallbackChain: new ProviderFallbackChain({ resolve: () => ({ chain: ["local", "cloud"], timing: DEFAULT_FALLBACK_TIMING }) }),
      resolveSlice: (id: string) => ({ provider: id === "local" ? primary : secondary, transport: "native_tools" as const, contextWindow: 200000 }), recordUnaryUsage() {}, recordStreamUsage() {} };
    const result = await executeStep(ctx, { ...deps(), modelMode: { ...cloud, mode: "local", providerId: "local" }, modelModePolicy: policy,
      llmComplete: createFallbackCompleter(seam), ...(stream ? { llmCompleteStream: createFallbackStreamer(seam) } : {}) });
    expect(result.nextSession.cloudLoadedSkills?.[0]?.body).toContain("BETA BODY");
    expect(result.nextSession.loadedSkills).toEqual([]);
  });

  it("loads workspace before compaction sees the request", async () => {
    const ctx = context(a); const d = deps();
    const policy = captureModelModePolicy({ activeTextProvider: "cloud", activeEmbeddingProvider: "cloud", toolTransport: "auto", providers: [{ id: "cloud", kind: "openrouter", modelMode: "cloud" }] });
    const beforeStep = vi.fn((input: BuildPromptInput) => { expect(input.workspace?.workingDir).toBe(a); expect(buildPrompt(input).text).toContain("ALPHA RULE"); return undefined; });
    const loop = new AgentLoop({ ...d, toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, skillCatalog: [], capabilities,
      onEvent: undefined, contextWindow: () => 200000, compaction: { open() {}, close() {}, beforeStep } });
    await loop.runTurn(ctx.session, { maxSteps: 1, signal: ctx.signal, modelModePolicy: policy }); expect(beforeStep).toHaveBeenCalled();
  });

  it("blocks a cached skill.view when the operator disables it after inference starts", async () => {
    const ctx = context(a); const d = deps(); ctx.session = (await executeStep(ctx, d)).nextSession;
    ctx.workspace = undefined;
    const second = await executeStep(ctx, { ...d, llmComplete: async params => {
      setSkillDisabled("guide", true, a); return d.llmComplete(params);
    } });
    expect(second.toolResults[0]?.status).toBe("error"); expect(second.toolResults[0]?.summary).toContain("disabled in workspace");
    expect(second.toolResults[0]?.details).not.toHaveProperty("skillAlreadyLoaded");
  });

  it("keeps rules/body out of the prefix, journals edits/removal and drops disabled state across compaction/resume", async () => {
    const ctx = context(a); const d = deps(); const loaded = await executeStep(ctx, d); ctx.session = loaded.nextSession;
    const first = prepareStepInference(ctx, d).prompt;
    expect(first.stablePrefix).not.toContain("ALPHA RULE"); expect(first.stablePrefix).not.toContain("ALPHA BODY");
    expect(first.cloudContext).toBe(prepareStepInference(ctx, d).prompt.cloudContext);
    writeFileSync(join(a, "AGENTS.md"), "CHANGED RULE");
    writeFileSync(join(a, ".agents/skills/guide/SKILL.md"), "---\nname: guide\ndescription: ALPHA GUIDE\n---\nCHANGED BODY");
    ctx.workspace = undefined;
    const edited = prepareStepInference(ctx, d).prompt; expect(edited.stablePrefix).toBe(first.stablePrefix); expect(edited.text).toContain("CHANGED BODY");
    setSkillDisabled("guide", true, a); rmSync(join(a, "AGENTS.md")); ctx.workspace = undefined;
    const disabled = prepareStepInference(ctx, d).prompt;
    expect(disabled.text).toContain("no longer active"); expect(ctx.session.cloudLoadedSkills).toEqual([]);
    ctx.session.turns.push(assistantReplyTurn("done"));
    ctx.session.compaction = { version: 1, summary: "Checkpoint", coveredThrough: ctx.session.turns.length, boundaryHash: compactionBoundaryHash(ctx.session.turns.at(-1)!), createdAt: 1, reason: "manual", model: null, tokensBefore: 1000, tokensAfter: 10 };
    ctx.session.turns.push(userTurn("continue"));
    const store = new SessionStore({ dbFile: ":memory:" });
    try { store.save(ctx.session); ctx.session = store.load(ctx.session.id)!; } finally { store.close(); }
    ctx.workspace = undefined; const compacted = prepareStepInference(ctx, d).prompt;
    expect(compacted.text).not.toContain("CHANGED BODY"); expect(compacted.text).not.toContain("CHANGED RULE");
    expect(prepareStepInference({ ...ctx, workspace: undefined }, { ...d, modelMode: { ...cloud, mode: "local" } }).prompt.text).not.toContain("CHANGED BODY");
    setSkillDisabled("guide", false, a); ctx.workspace = undefined;
    prepareStepInference(ctx, d); expect(ctx.session.cloudLoadedSkills).toEqual([]);
  });

  it("previews selected session B without writing A/B state; local inherits only Atomic skills", () => {
    const ca = context(a); const cb = context(b); const loader = createWorkspaceLoader(getConfig());
    const preview = createRuntimePromptPreview(getConfig(), { workingDir: a, capabilities, sessionStore: { load: id => id === a ? ca.session : cb.session }, profileStore: { listForPrompt: () => [] },
      effectiveToolDescriptors: () => [], getSkillCatalog: () => [], getLiveProfile: () => PLAIN_INSTRUCT_PROFILE,
      resolveToolTransport: () => "native_tools", resolveModelMode: () => cloud, resolveCatalogContextWindow: () => 200000, prepareWorkspace: loader });
    expect(preview({ sessionId: b }).text).toContain("BETA RULE"); expect(preview({ sessionId: b }).text).not.toContain("ALPHA");
    expect(ca.session.cloudContext).toBeUndefined(); expect(cb.session.cloudContext).toBeUndefined();
    mkdirSync(join(b, ".atomic-agent/skills/native"), { recursive: true });
    writeFileSync(join(b, ".atomic-agent/skills/native/SKILL.md"), "---\nname: native\ndescription: NATIVE GUIDE\nversion: 1.0.0\n---\nNATIVE BODY");
    cb.session.inheritedWorkspace = true;
    const inherited = prepareStepInference(cb, { ...deps(), modelMode: { ...cloud, mode: "local" } });
    expect(inherited.prompt.text).toContain("NATIVE GUIDE"); expect(inherited.prompt.text).not.toContain("BETA GUIDE"); expect(inherited.prompt.text).not.toContain("BETA RULE");
    expect(inherited.prompt.stablePrefix).toContain(b); expect(inherited.prompt.stablePrefix).not.toContain("/boot");
    expect(reconcileCloudSkills(cb.session, loader(cb.session, true)).loadedSkills).toEqual([]);
  });
});
