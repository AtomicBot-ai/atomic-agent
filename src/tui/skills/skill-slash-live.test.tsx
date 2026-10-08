import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { ensureUserConfigFileSync, writeUserConfigFileSync, getConfig, resetConfigCache } from "../../config/index.js";
import { setSkillDisabled } from "../../config/skill-policy-commands.js";
import { createAgentRuntime } from "../../runtime/bootstrap.js";
import { FakeBrowserBackend } from "../../http/test-harness.js";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import { ChatOrchestrator } from "../chat-orchestrator.js";
import { TuiApp, makeTuiEventBus } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";
import { makeMouseSource } from "../mouse/mouse-source.js";
import type { TuiAction } from "../tui-action.js";

afterEach(() => { vi.unstubAllEnvs(); resetConfigCache(); });

function completion(content: string): CompletionResult {
  return { content, reasoningContent: "", stop: true, truncated: false,
    timing: { promptTokens: 100, predictedTokens: 30, promptMs: 1, predictedMs: 1 },
    cacheHitTokens: 0, slotId: 0, modelId: "test-model" };
}

async function fixture(cloud = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skill-slash-live-")));
  const workspace = join(dir, "project");
  for (const source of [".agents", ".claude"]) {
    const root = join(workspace, source, "skills", "openspec-explore");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), `---\nname: openspec-explore\ndescription: Explore project requirements\n---\n${source} EXPLORE BODY`);
  }
  vi.stubEnv("ATOMIC_AGENT_STATE_DIR", join(dir, "state"));
  vi.stubEnv("ATOMIC_AGENT_GRAMMARS_DIR", join(process.cwd(), "grammars"));
  resetConfigCache();
  const config = getConfig();
  config.agent.nameSessions = false;
  config.memory.reflection.enabled = false;
  config.agent.compaction.auto = false;
  config.llm = { activeTextProvider: "local-llama", activeEmbeddingProvider: "local-llama", toolTransport: "grammar",
    providers: [{ id: "local-llama", kind: "llama-server", modelMode: cloud ? "cloud" : "local" }] };
  const file = structuredClone(ensureUserConfigFileSync(config.paths.userConfigFile));
  file.llm = { activeTextProvider: "local-llama", activeEmbeddingProvider: "local-llama", toolTransport: "grammar",
    providers: [{ id: "local-llama", kind: "llama-server", modelMode: cloud ? "cloud" : "local" }] };
  writeUserConfigFileSync(config.paths.userConfigFile, file);
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const actions: TuiAction[] = [];
  bus.subscribe(action => actions.push(action));
  const prompts: string[] = [];
  const runtime = await createAgentRuntime({ workingDir: workspace, approvalLevel: 5,
    handlers: { onAgentEvent: (event, sessionId) => bus.emitAgentEvent(event, sessionId) },
    overrides: { browserBackend: new FakeBrowserBackend(), skipLlamaHealthCheck: true,
      llamaComplete: async p => {
        prompts.push(p.prompt);
        return completion(prompts.length === 1
          ? '[{"tool":"skill.view","args":{"name":"openspec-explore"}}]'
          : '[{"tool":"reply","args":{"text":"Skill loaded successfully"}}]');
      } },
  });
  const orchestrator = new ChatOrchestrator(runtime, bus, {
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: () => ({ activeProviderIsLocal: false, managedMode: false, modelId: null, modelDownloaded: true, fallbackChainLength: 1 }),
  });
  const app = render(<TuiApp session={fakeSession({ sessionId: null, workingDir: workspace })} bus={bus} mouse={mouse} callbacks={{
    onApprovalDecision() {}, onAbort: () => orchestrator.abortCurrentTurn(), onQuit() {},
    onMessageSubmitted: text => orchestrator.sendMessage(text),
    onMessageSteered: text => orchestrator.steerMessage(text),
    onSkillsRefreshRequested: () => orchestrator.skills.refresh(),
    prepareSkillInvocation: (name, input) => orchestrator.skills.prepareInvocation(name, input),
  }} />);
  await new Promise(resolve => setTimeout(resolve, 50));
  return { dir, workspace, app, runtime, orchestrator, prompts, actions, mouse,
    frame: () => (app.lastFrame() ?? "").replace(/\u001b\[[0-9;]*m/g, ""),
    async close() { app.unmount(); await orchestrator.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

it.each(["keyboard", "mouse"])("discovers and invokes a cloud project skill before the first message using %s", async input => {
  const f = await fixture();
  try {
    expect(f.actions.some(a => a.type === "session_created")).toBe(false);
    f.app.stdin.write("/openspec");
    await vi.waitFor(() => expect(f.frame()).toContain("Explore project requirements"));
    const catalog = f.actions.filter(a => a.type === "skills_refreshed").at(-1);
    expect(catalog?.rows.filter(r => r.name === "openspec-explore")).toHaveLength(1);
    expect(catalog?.rows.find(r => r.name === "openspec-explore")?.sourcePath).toContain(".agents/skills");
    if (input === "keyboard") {
      f.app.stdin.write("\t");
      await vi.waitFor(() => expect(f.frame()).not.toContain("Explore project requirements"));
      f.app.stdin.write("investigate workspace selection");
      await new Promise(resolve => setTimeout(resolve, 30));
      f.app.stdin.write("\r");
    } else {
      await vi.waitFor(() => {
        const lines = f.frame().split("\n");
        const y = lines.findIndex(line => line.includes("Explore project requirements"));
        if (y >= 0) {
          const x = lines[y]!.indexOf("/openspec-explore");
          f.mouse.emit({ kind: "press", button: "left", wheel: null, x, y, shift: false, alt: false, ctrl: false });
        }
        expect(f.prompts.length).toBeGreaterThan(0);
      });
    }
    await vi.waitFor(() => expect(f.frame()).toContain("Skill loaded successfully"));
    expect(f.prompts[0]).toContain('skill.view({"name":"openspec-explore"})');
    if (input === "keyboard") expect(f.prompts[0]).toContain("investigate workspace selection");
    expect(f.prompts[1]).toContain(".agents EXPLORE BODY");
    expect(f.prompts[1]).not.toContain(".claude EXPLORE BODY");
    expect(f.frame()).not.toContain("unknown command");
  } finally { await f.close(); }
});

it("rechecks disabling after the palette was shown and preserves the unsent request", async () => {
  const f = await fixture();
  try {
    f.app.stdin.write("/openspec-explore explain routing");
    await vi.waitFor(() => expect(f.frame()).toContain("explain routing"));
    setSkillDisabled("openspec-explore", true, f.workspace);
    f.app.stdin.write("\r");
    await vi.waitFor(() => expect(f.frame()).toContain("disabled in workspace"));
    expect(f.prompts).toHaveLength(0);
    expect(f.frame()).toContain("/openspec-explore explain routing");
  } finally { await f.close(); }
});

it("keeps local slash behavior unchanged", async () => {
  const f = await fixture(false);
  try {
    f.app.stdin.write("/openspec-explore");
    await vi.waitFor(() => expect(f.frame()).toContain("/openspec-explore"));
    expect(f.frame()).not.toContain("Explore project requirements");
    f.app.stdin.write("\r");
    await vi.waitFor(() => expect(f.frame()).toContain("unknown command: /openspec-explore"));
    expect(f.prompts).toHaveLength(0);
  } finally { await f.close(); }
});

it("changes suggestions and counts with the selected session workspace", async () => {
  const f = await fixture();
  try {
    const other = join(f.dir, "other");
    const skillDir = join(other, ".claude/skills/workspace-beta");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\ndescription: Beta workspace only\n---\nBeta body");
    const a = f.runtime.createSession();
    const b = { ...f.runtime.createSession(), workingDir: other };
    f.runtime.sessionStore.save(b);
    f.orchestrator.switchSession(a.id);
    f.app.stdin.write("/openspec");
    await vi.waitFor(() => expect(f.frame()).toContain("Explore project requirements"));
    f.orchestrator.switchSession(b.id);
    await vi.waitFor(() => expect(f.frame()).not.toContain("Explore project requirements"));
    f.app.stdin.write("/workspace-beta");
    await vi.waitFor(() => expect(f.frame()).toContain("Beta workspace only"));
    const catalog = f.actions.filter(a => a.type === "skills_refreshed").at(-1)!;
    expect(catalog.workspace).toBe(other);
    expect(catalog.rows.some(r => r.name === "openspec-explore")).toBe(false);
    expect(f.actions.filter(a => a.type === "skill_count_changed").at(-1)?.count)
      .toBe(catalog.rows.filter(r => !r.disabled).length);
    f.orchestrator.switchSession(a.id);
    await vi.waitFor(() => expect(f.actions.filter(a => a.type === "skills_refreshed").at(-1)?.workspace).toBe(f.workspace));
    // Session switching restores the draft with overlays closed; resume typing.
    await new Promise(resolve => setTimeout(resolve, 30));
    f.app.stdin.write("-");
    await vi.waitFor(() => expect(f.frame()).toContain("Explore project requirements"));
    expect(f.frame()).not.toContain("Beta workspace only");
  } finally { await f.close(); }
});
