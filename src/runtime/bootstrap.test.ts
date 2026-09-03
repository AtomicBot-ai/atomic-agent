import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createAgentRuntime, managedLocalLlmHealthFailureHint } from "./bootstrap.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import {
  buildSearchCacheKey,
  createPersistentSearchCache,
} from "../tools/os/web-search/transport/index.js";
import type {
  BotFactory,
  BotInstance,
} from "../channels/telegram/index.js";
import type {
  ApprovalGate,
  ApprovalRequest,
} from "../approval/approval-gate.js";
import type { ChannelStatus } from "./channel-status.js";
import { GEMMA4_PROPS } from "../llm/model-profile.fixtures.js";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "../tools/browser/browser-backend.js";
import { buildSkillCatalog } from "../skills/index.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { CompletionResult } from "../llm/llama-server-client.js";

class FakeBackend implements BrowserBackend {
  public shutdowns = 0;
  async ensureReady(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }
  async snapshot(): Promise<AriaSnapshot> {
    return {
      url: "https://example.com/",
      title: "Example",
      digest: "deadbeef",
      refs: [],
      text: "url: https://example.com/\ntitle: Example\n",
    };
  }
  async navigate(input: NavigateInput): Promise<{ url: string; title: string }> {
    return { url: input.url, title: "Example" };
  }
  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    return { clickedRef: input.ref };
  }
  async type(input: TypeInput): Promise<{ typedLength: number }> {
    return { typedLength: input.text.length };
  }
  async search(input: SearchInput): Promise<{ url: string }> {
    return { url: `https://search.example/?q=${input.query}` };
  }
  async tabs(_input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    return { tabs: [] };
  }
  async hasRef(): Promise<boolean> {
    return false;
  }
  async scroll(_input: ScrollInput): Promise<ScrollResult> {
    return { scrollY: 0, scrollHeight: 0, viewportHeight: 800 };
  }
}

describe("createAgentRuntime", () => {
  let stateDir: string;
  let workingDir: string;
  let backend: FakeBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-"));
    // Project-local skills dir so the skill loader has somewhere to look.
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    backend = new FakeBackend();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
    resetConfigCache();
  });

  it("wires the full tool catalog (browser + os + skill + finish)", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
      },
    });
    try {
      const names = runtime.toolRegistry.list().map((t) => t.name).sort();
      expect(names).toContain("finish");
      expect(names).toContain("browser.navigate");
      expect(names).toContain("browser.click");
      expect(names).toContain("browser.type");
      expect(names).toContain("browser.read_aria");
      expect(names).toContain("os.shell.run");
      expect(names).toContain("os.fs.read");
      expect(names).toContain("os.fs.write");
      expect(names).toContain("os.fs.trash");
      expect(names).toContain("os.clipboard.read");
      expect(names).toContain("skill.view");
      expect(names).toContain("skill.run_script");
    } finally {
      await runtime.shutdown();
    }
  });

  it("wires skills.catalogTokenBudget into the runtime skill catalog, at boot and on refresh", async () => {
    // Regression guard for the call-site wiring itself: the original bug
    // was `buildSkillCatalog` being called WITHOUT options in bootstrap,
    // which silently pinned the catalog to the legacy 4096-char cap. The
    // unit tests on `buildSkillCatalog` cannot catch that, so this test
    // sets the env knob and asserts the built runtime honors it.
    const writeProjectSkill = (name: string): void => {
      const dir = join(workingDir, ".atomic-agent", "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        [
          "---",
          `name: ${name}`,
          `description: "${"d".repeat(120)}"`,
          "version: 0.1.0",
          "---",
          "",
          `# ${name}`,
        ].join("\n"),
        "utf8",
      );
    };
    writeProjectSkill("budget-a");
    writeProjectSkill("budget-b");

    // 4 tokens x 8 chars/token = 32 chars: far below one rendered entry,
    // so an honored budget collapses the catalog to the single
    // always-kept first entry, while the legacy 4096-char default would
    // keep every skill written above.
    process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET = "4";
    resetConfigCache();
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.config.skills.catalogTokenBudget).toBe(4);
      const records = runtime.skillRegistry.list();
      expect(records.length).toBeGreaterThan(1);
      // Sanity: with the default cap this registry yields a bigger catalog,
      // so the assertion below genuinely discriminates wired vs unwired.
      expect(buildSkillCatalog(records).length).toBeGreaterThan(1);
      expect([...runtime.skillCatalog]).toEqual(
        buildSkillCatalog(records, { tokenBudget: 4 }),
      );
      expect(runtime.skillCatalog).toHaveLength(1);

      // Second call site: the refresh path must rebuild with the same
      // configured budget, not fall back to the legacy cap.
      writeProjectSkill("budget-c");
      await runtime.refreshSkills();
      expect(runtime.skillRegistry.list().length).toBeGreaterThan(
        records.length,
      );
      expect(runtime.skillCatalog).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
      resetConfigCache();
    }
  });

  it("keeps the ApprovalGate the single live switch: a level-5 boot flips back to interactive", async () => {
    // Locked invariant: tools always register `approvalRequired: true`;
    // the boot level lands in the gate. A tool-level `false` would
    // freeze this boot's value forever and the second half of this test
    // would hang waiting for a prompt that never fires.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: false,
            reason: "test-denied",
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-approve-flip",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
      // Level-5 boot: dangerous navigation runs without a prompt.
      await runtime.toolRegistry.invoke(
        "browser.navigate",
        { url: "file:///etc/hosts" },
        ctx,
      );
      expect(prompts).toHaveLength(0);

      runtime.setApprovalLevel(1);
      await expect(
        runtime.toolRegistry.invoke(
          "browser.navigate",
          { url: "file:///etc/hosts" },
          ctx,
        ),
      ).rejects.toThrow(/approval denied/);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.tool).toBe("browser.navigate");
    } finally {
      await runtime.shutdown();
    }
  });

  it("level 2 end-to-end: workspace writes run silently, home writes ask, hardline still blocks", async () => {
    // The main path of the ladder, through the real runtime + real
    // tools: at level 2 a write inside the session cwd needs no prompt,
    // a write into the home directory prompts (denied here so nothing
    // lands), and a catastrophic shell command is blocked by the
    // hardline guard BEFORE the gate — no prompt at any level.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 2,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: false,
            reason: "test-denied",
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-level-2",
        stepIndex: 0,
        signal: new AbortController().signal,
      };

      // 1. Write inside the workspace: silent and actually lands.
      const inWorkspace = join(workingDir, "notes.txt");
      const ok = await runtime.toolRegistry.invoke(
        "os.fs.write",
        { path: inWorkspace, content: "hello" },
        ctx,
      );
      expect(ok.status).toBe("ok");
      expect(readFileSync(inWorkspace, "utf8")).toBe("hello");
      expect(prompts).toHaveLength(0);

      // 2. Write into the real home directory: prompts (fs_write_home is
      // level 3). The prompt is denied so the file never appears.
      const inHome = join(
        homedir(),
        `atomic-agent-e2e-${randomBytes(6).toString("hex")}.txt`,
      );
      await expect(
        runtime.toolRegistry.invoke(
          "os.fs.write",
          { path: inHome, content: "must not land" },
          ctx,
        ),
      ).rejects.toThrow(/approval denied/);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.category).toBe("fs_write_home");
      expect(existsSync(inHome)).toBe(false);

      // 3. Hardline guard fires before the gate: no prompt, no spawn.
      const blocked = await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "rm", args: ["-rf", "/"] },
        ctx,
      );
      expect(blocked.status).toBe("error");
      expect(blocked.summary).toContain("blocked by shell guard");
      expect(prompts).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("C1: writing the agent's own config.json prompts even at level 4 (trust_config)", async () => {
    // Escalation guard: config.json holds agent.approvalLevel. Without a
    // dedicated category a write to it would categorise by scope; here
    // we prove the gate stops it at level 4 (where shell/script/kill are
    // already silent) and surfaces category `trust_config`. Denied, so
    // the file the runtime wrote at boot is not clobbered.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 4,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: false,
            reason: "test-denied",
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-trust-config",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
      const configPath = runtime.config.paths.userConfigFile;
      await expect(
        runtime.toolRegistry.invoke(
          "os.fs.write",
          { path: configPath, content: '{"agent":{"approvalLevel":5}}' },
          ctx,
        ),
      ).rejects.toThrow(/approval denied/);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.category).toBe("trust_config");
    } finally {
      await runtime.shutdown();
    }
  });

  it("threads stateDir into os.web.search: a cache seeded by the last process answers without the network (#256)", async () => {
    // Pins the enablement seam itself — the `stateDir: config.paths.stateDir`
    // argument in createAgentRuntime and the pass-through in registerOsTools.
    // Every other #256 test constructs the persistent cache or the tool
    // directly, so deleting either wiring line would leave them all green
    // while the shipped runtime silently regressed to the pre-#256 in-memory
    // cache — the invisible-degradation failure mode #256 exists to close.
    // Same idea as the trust_config case above pinning `trustConfigPaths`.
    //
    // The provider is a searxng instance on a closed local port, so a broken
    // seam fails fast with a connection error instead of a live provider call;
    // the passing path never leaves the cache file.
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      web: {
        ...USER_CONFIG_DEFAULTS.web,
        search: {
          ...USER_CONFIG_DEFAULTS.web.search,
          provider: "searxng",
          fallback: [],
          searxng: { instanceUrl: "http://127.0.0.1:9" },
        },
      },
    });
    resetConfigCache();

    // What the previous per-task process left behind in stateDir.
    const query = "query answered by the previous process";
    const seeded = createPersistentSearchCache({
      ttlMs: 60_000,
      filePath: join(stateDir, "web-search-cache.json"),
    });
    seeded.set(
      buildSearchCacheKey(
        "searxng",
        query,
        USER_CONFIG_DEFAULTS.web.search.maxResults,
      ),
      [
        {
          title: "Seeded by the last process",
          url: "https://example.com/seeded",
          snippet: "still warm",
        },
      ],
    );

    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const result = await runtime.toolRegistry.invoke(
        "os.web.search",
        { query },
        {
          workingDir,
          sessionId: "s-search-persist",
          stepIndex: 0,
          signal: new AbortController().signal,
        },
      );
      expect(result.status).toBe("ok");
      expect(result.details.fromCache).toBe(true);
      expect(result.summary).toContain("https://example.com/seeded");
    } finally {
      await runtime.shutdown();
    }
  });

  it("session grant (category) end-to-end: s silences the shell category for the rest of the session, hardline still blocks", async () => {
    // Issue #79 prompt-side grant, through the real runtime + real shell
    // tool + real guard. At level 1 every guarded shell command asks. The
    // operator answers the first with a category grant; every later shell
    // command runs silently, but the hardline guard still blocks a
    // catastrophic command despite the grant.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 1,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: true,
            grant: "category",
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-grant-category",
        stepIndex: 0,
        signal: new AbortController().signal,
      };

      // 1. First guarded shell command asks; approved with a category grant.
      const first = await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "git", args: ["--version"] },
        ctx,
      );
      expect(first.status).toBe("ok");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.category).toBe("shell");
      expect(gate.sessionGrants().categories).toEqual(["shell"]);

      // 2. A different shell binary now runs silently under the grant.
      const second = await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "ls", args: [workingDir] },
        ctx,
      );
      expect(second.status).toBe("ok");
      expect(prompts).toHaveLength(1);

      // 3. Hardline still fires before the gate, grant or no grant.
      const blocked = await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "rm", args: ["-rf", "/"] },
        ctx,
      );
      expect(blocked.status).toBe("error");
      expect(blocked.summary).toContain("blocked by shell guard");
      expect(prompts).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("session grant (shape) end-to-end: a silences one binary; a different binary still asks", async () => {
    // The narrower grant: `a` covers exactly the command binary, so a
    // second run of the same binary is silent while a different binary
    // still prompts. Records the shape from the gate's own request, not
    // the caller's word.
    const prompts: ApprovalRequest[] = [];
    let gate: ApprovalGate | null = null;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 1,
      handlers: {
        onApprovalRequest: (request) => {
          prompts.push(request);
          gate?.resolve({
            approvalId: request.approvalId,
            approved: true,
            // Only grant a shape for the git binary; deny-by-approve the
            // rest so a second unrelated binary still prompts.
            ...(request.commandShape === "git" ? { grant: "shape" as const } : {}),
          });
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    gate = runtime.approvals;
    try {
      const ctx = {
        workingDir,
        sessionId: "s-grant-shape",
        stepIndex: 0,
        signal: new AbortController().signal,
      };

      // 1. First git command asks and grants the git shape.
      await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "git", args: ["--version"] },
        ctx,
      );
      expect(prompts).toHaveLength(1);
      expect(gate.sessionGrants().shapes).toEqual(["git"]);

      // 2. A second git command is silent under the shape grant.
      await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "git", args: ["status", "--porcelain"] },
        ctx,
      );
      expect(prompts).toHaveLength(1);

      // 3. A different binary is not covered by the git shape; it asks.
      await runtime.toolRegistry.invoke(
        "os.shell.run",
        { cmd: "ls", args: [workingDir] },
        ctx,
      );
      expect(prompts).toHaveLength(2);
      expect(prompts[1]?.commandShape).toBe("ls");
    } finally {
      await runtime.shutdown();
    }
  });

  it("builds a capabilities summary and grammar", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.capabilities.workingDir).toBe(workingDir);
      expect(runtime.capabilities.browserChannel).toBeDefined();
      expect(runtime.grammar).toContain("tool-name");
      expect(runtime.toolDescriptors.length).toBeGreaterThan(5);
    } finally {
      await runtime.shutdown();
    }
  });

  it("runs a turn to session completion when LLM emits finish", async () => {
    const events: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        onAgentEvent: (e) => events.push(e.type),
      },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "finish",
            args: { summary: "done" },
          }),
          timing: { promptTokens: 10, predictedTokens: 5 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const session = runtime.createSession();
      const result = await runtime.runTurn(session, "wrap up", { maxSteps: 3 });
      expect(result.reason).toBe("finish");
      expect(result.session.status).toBe("completed");
      expect(events).toContain("step_started");
      expect(events).toContain("step_finished");
      expect(events).toContain("loop_completed");
    } finally {
      await runtime.shutdown();
    }
  });

  it("shutdown closes the browser backend and is idempotent", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    await runtime.shutdown();
    await runtime.shutdown();
    expect(backend.shutdowns).toBe(1);
  });

  it("multi-turn chat: two consecutive runTurn calls accumulate transcript", async () => {
    const replies = ["hi back", "second answer"];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async (params) => {
          // Reflection runner shares the main llmComplete; short-circuit
          // its calls with a NONE completion so the scripted `replies`
          // queue only serves the actual agent turns.
          if (params.sessionId.startsWith("reflection:")) {
            return {
              content: "NONE\n",
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
              cacheHitTokens: 0,
              slotId: params.slotId,
              modelId: null,
            };
          }
          // Sub-calls (query-rewriter, link-gen, …) use slotId -1 — do not
          // consume the scripted agent reply queue.
          if (params.slotId === -1) {
            return {
              content: "<rewritten_query>NONE</rewritten_query>\n",
              reasoningContent: "",
              stop: true,
              truncated: false,
              timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
              cacheHitTokens: 0,
              slotId: -1,
              modelId: null,
            };
          }
          const text = replies.shift() ?? "fallback";
          return {
            content: JSON.stringify({ tool: "reply", args: { text } }),
            reasoningContent: "",
            stop: true,
            truncated: false,
            timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
            cacheHitTokens: 0,
            slotId: params.slotId,
            modelId: null,
          };
        },
      },
    });
    try {
      const initial = runtime.createSession();
      const first = await runtime.runTurn(initial, "hi", { maxSteps: 3 });
      expect(first.reason).toBe("reply");
      expect(first.session.turnCount).toBe(1);
      const second = await runtime.runTurn(first.session, "more please", {
        maxSteps: 3,
      });
      expect(second.reason).toBe("reply");
      expect(second.session.turnCount).toBe(2);
      const kinds = second.session.turns.map((t) => t.kind);
      expect(kinds).toEqual([
        "user",
        "assistant_reply",
        "user",
        "assistant_reply",
      ]);
      expect((second.session.turns[1] as { text: string }).text).toBe("hi back");
      expect((second.session.turns[3] as { text: string }).text).toBe(
        "second answer",
      );
    } finally {
      await runtime.shutdown();
    }
  });

  it("runtime.runTurn appends user message and reaches a reply", async () => {
    const events: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: { onAgentEvent: (e) => events.push(e.type) },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "reply",
            args: { text: "hi back" },
          }),
          timing: { promptTokens: 5, predictedTokens: 3 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const session = runtime.createSession();
      expect(session.turns).toEqual([]);
      const result = await runtime.runTurn(session, "hello", { maxSteps: 5 });
      expect(result.reason).toBe("reply");
      expect(result.session.turnCount).toBe(1);
      expect(result.session.turns[0]).toMatchObject({ kind: "user", text: "hello" });
      expect(result.session.turns.at(-1)).toMatchObject({
        kind: "assistant_reply",
        text: "hi back",
      });
      const reloaded = runtime.sessionStore.load(session.id)!;
      expect(reloaded.turnCount).toBe(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("persists the turn's context usage onto the stored session", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "reply",
            args: { text: "hi back" },
          }),
          timing: { promptTokens: 777, predictedTokens: 3 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const session = runtime.createSession();
      const result = await runtime.runTurn(session, "hello", { maxSteps: 5 });
      // `prompt_built` seeded the snapshot; `llm_completed`'s tokenizer
      // count (777) replaced the estimate before the stamp.
      expect(result.session.contextUsage).toBeDefined();
      expect(result.session.contextUsage?.tokens).toBe(777);
      expect(result.session.contextUsage?.sections.length).toBeGreaterThan(0);
      // The stored row carries the same snapshot, so a later process —
      // the TUI reopening this session — can restore the gauge.
      const reloaded = runtime.sessionStore.load(session.id)!;
      expect(reloaded.contextUsage).toEqual(result.session.contextUsage);
    } finally {
      await runtime.shutdown();
    }
  });

  it("refreshSkills rebuilds the catalog and notifies listeners", async () => {
    let notified: Array<{ name: string }> = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        onSkillRegistryChange: (entries) => {
          notified = entries.map((e) => ({ name: e.name }));
        },
      },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const names = runtime.skillCatalog.map((e) => e.name).sort();
      expect(names).toContain("skill-creator");
      expect(names).toContain("wttr-weather");
      expect(names).not.toContain("exa-web-search");
      await runtime.refreshSkills();
      expect(notified.map((e) => e.name).sort()).toEqual(names);
    } finally {
      await runtime.shutdown();
    }
  });

  it("uses llamaProps override to resolve a gemma 4 grammar", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaProps: GEMMA4_PROPS,
      },
    });
    try {
      expect(runtime.grammar).toContain(
        "root ::= channel-prelude tool-call-array",
      );
      expect(runtime.grammar).toContain("<channel|>");
    } finally {
      await runtime.shutdown();
    }
  });

  it("starts the scheduler by default and stops it before taskStore closes", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.scheduler).not.toBeNull();
    } finally {
      await runtime.shutdown();
    }
    // A double shutdown after the scheduler has stopped must not
    // re-throw — ordering invariant: scheduler.stop before taskStore.close.
    await runtime.shutdown();
  });

  it("registers the five tasks.* agent tools when enabled", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const names = runtime.toolRegistry.list().map((t) => t.name);
      expect(names).toContain("tasks.schedule");
      expect(names).toContain("tasks.cron");
      expect(names).toContain("tasks.list");
      expect(names).toContain("tasks.cancel");
      expect(names).toContain("tasks.show");
    } finally {
      await runtime.shutdown();
    }
  });

  it("disables scheduler and tasks.* tools when tasks.enabled=false", async () => {
    process.env.ATOMIC_AGENT_TASKS_ENABLED = "false";
    resetConfigCache();
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.scheduler).toBeNull();
      const names = runtime.toolRegistry.list().map((t) => t.name);
      expect(names).not.toContain("tasks.schedule");
      expect(names).not.toContain("tasks.cron");
    } finally {
      await runtime.shutdown();
      delete process.env.ATOMIC_AGENT_TASKS_ENABLED;
      resetConfigCache();
    }
  });

  it("managedLocalLlmHealthFailureHint documents CLI daemon control", () => {
    expect(managedLocalLlmHealthFailureHint(18991)).toContain("atomic-agent models start");
    expect(managedLocalLlmHealthFailureHint(18991)).toContain("127.0.0.1:18991");
  });

  // -----------------------------------------------------------------
  // Telegram channel construction + shutdown ordering. The three
  // construction branches (`enabled=false`, `enabled=true` with no
  // env token, `enabled=true` with a fake bot factory) are exercised
  // separately and then the shutdown-order invariant —
  // `telegramChannel.stop()` must run before `sessionStore.close()` —
  // is asserted via `vi.fn().mock.invocationCallOrder` so a future
  // refactor of the shutdown sequence will fail loudly.
  // -----------------------------------------------------------------

  /** Write a config v9 file with `telegram.enabled` overridden. */
  function enableTelegramInConfig(): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      telegram: { ...USER_CONFIG_DEFAULTS.telegram, enabled: true },
    });
    resetConfigCache();
  }

  /** Build a fake `BotFactory` whose `stop` is a recordable spy. */
  function makeFakeBotFactory(): {
    factory: BotFactory;
    stopSpy: ReturnType<typeof vi.fn>;
  } {
    const stopSpy = vi.fn(async () => undefined);
    const factory: BotFactory = () => {
      const bot: BotInstance = {
        api: {
          sendMessage: vi.fn(async () => ({ message_id: 1 })),
          getMe: vi.fn(async () => ({ id: 1, username: "test_bot" })),
          setMyCommands: vi.fn(async () => undefined),
        },
        setTextHandler: () => undefined,
        start: () => undefined,
        stop: stopSpy,
      };
      return bot;
    };
    return { factory, stopSpy };
  }

  /** Spin until `predicate` is true or `timeoutMs` elapses. */
  async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 1000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }

  it("telegramChannel is constructed but stays disabled when telegram.enabled is false (default)", async () => {
    // Slice 3B invariant: the channel is *always* constructed so the
    // TUI live-control surface can flip `enabled=true` without
    // restarting the runtime. With the default config (`enabled=false`)
    // the channel stays in `disabled` state and emits no lifecycle
    // events because `start()` is never called.
    const statuses: ChannelStatus[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: { onChannelStatus: (s) => statuses.push(s) },
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      expect(runtime.telegramChannel).not.toBeNull();
      expect(runtime.telegramChannel!.state()).toBe("disabled");
      expect(statuses).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("telegramChannel is constructed but reports `down` when token is missing", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const statuses: ChannelStatus[] = [];
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalLevel: 5,
        handlers: { onChannelStatus: (s) => statuses.push(s) },
        overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
      });
      try {
        expect(runtime.telegramChannel).not.toBeNull();
        await waitFor(() => runtime.telegramChannel!.state() === "down");
        expect(runtime.telegramChannel!.lastError()).toBe(
          "missing TELEGRAM_BOT_TOKEN",
        );
        expect(statuses.at(-1)).toMatchObject({
          channel: "telegram",
          state: "down",
          lastError: "missing TELEGRAM_BOT_TOKEN",
        });
      } finally {
        await runtime.shutdown();
      }
    } finally {
      if (previousToken !== undefined) {
        process.env.TELEGRAM_BOT_TOKEN = previousToken;
      }
    }
  });

  it("telegramChannel reaches `up` when enabled and a fake bot factory is wired", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "1234:test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const statuses: ChannelStatus[] = [];
    const { factory } = makeFakeBotFactory();
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalLevel: 5,
        handlers: { onChannelStatus: (s) => statuses.push(s) },
        overrides: {
          browserBackend: backend,
          skipLlamaHealthCheck: true,
          telegramBotFactory: factory,
        },
      });
      try {
        expect(runtime.telegramChannel).not.toBeNull();
        await waitFor(() => runtime.telegramChannel!.state() === "up");
        expect(runtime.telegramChannel!.lastError()).toBeNull();
        expect(statuses.map((s) => s.state)).toContain("starting");
        expect(statuses.map((s) => s.state)).toContain("up");
      } finally {
        await runtime.shutdown();
      }
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("shutdown stops the Telegram channel before closing the session store", async () => {
    enableTelegramInConfig();
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "1234:test-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const { factory, stopSpy } = makeFakeBotFactory();
    try {
      const runtime = await createAgentRuntime({
        workingDir,
        approvalLevel: 5,
        overrides: {
          browserBackend: backend,
          skipLlamaHealthCheck: true,
          telegramBotFactory: factory,
        },
      });
      // Wait until the channel is `up` so shutdown actually has a bot
      // instance to stop — otherwise the `bot.stop()` branch is skipped
      // and the test would only assert that close ran.
      await waitFor(() => runtime.telegramChannel!.state() === "up");
      const closeSpy = vi.spyOn(runtime.sessionStore, "close");

      await runtime.shutdown();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      const stopOrder = stopSpy.mock.invocationCallOrder[0]!;
      const closeOrder = closeSpy.mock.invocationCallOrder[0]!;
      expect(stopOrder).toBeLessThan(closeOrder);
    } finally {
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it("warns once and falls back to plain profile when props probing fails", async () => {
    const logs: LogRecord[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: {
        logSinks: [(record) => logs.push(record)],
      },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaPropsError: new Error("boom"),
        llamaComplete: async () => ({
          content: JSON.stringify({
            tool: "reply",
            args: { text: "hi back" },
          }),
          timing: { promptTokens: 5, predictedTokens: 3 },
          slotId: 0,
          cacheReused: false,
        }),
      },
    });
    try {
      const result = await runtime.runTurn(runtime.createSession(), "hello", { maxSteps: 2 });
      expect(result.reason).toBe("reply");
      expect(runtime.grammar).toContain("root ::= tool-call");
      const warnings = logs.filter(
        (record) => record.level === "warn" && record.message === "model profile probe failed; using plain fallback",
      );
      expect(warnings).toHaveLength(1);
    } finally {
      await runtime.shutdown();
    }
  });
});

describe("createAgentRuntime steering", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-steer-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-steer-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    delete process.env.ATOMIC_AGENT_SKILLS_CATALOG_BUDGET;
    resetConfigCache();
  });

  it("refuses to steer a session with no turn in flight", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: new FakeBackend(), skipLlamaHealthCheck: true },
    });
    try {
      const session = runtime.createSession();
      // Nothing is running: steering would silently vanish, so the
      // caller is told "no" and can fall back to a normal turn.
      expect(runtime.steer(session.id, "hello?")).toBe(false);
      expect(runtime.steeringInbox.peek(session.id)).toEqual([]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("accepts a steer while a turn holds the session lock", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: new FakeBackend(), skipLlamaHealthCheck: true },
    });
    try {
      const session = runtime.createSession();
      let release!: () => void;
      const held = new Promise<void>((res) => {
        release = res;
      });
      const inFlight = runtime.turnController.enqueue({
        sessionId: session.id,
        origin: "tui",
        run: async () => {
          // Stand in for `AgentLoop.runTurn`, which opens the steering
          // window on entry — the queue lock alone is not what makes a
          // session steerable.
          runtime.steeringInbox.open(session.id);
          expect(runtime.steer(session.id, "change course")).toBe(true);
          expect(runtime.steeringInbox.peek(session.id)).toEqual([
            "change course",
          ]);
          await held;
          return null;
        },
      });
      release();
      await inFlight;
      // Still pending: only the agent loop drains it.
      expect(runtime.steeringInbox.drain(session.id)).toEqual(["change course"]);
    } finally {
      await runtime.shutdown();
    }
  });

  /**
   * The lost-update window. `runTurn` is `enqueue({ run: () =>
   * executeTurn(...) })`; spelling that composition out by hand is the
   * only way to stand *between* the loop's final drain and the
   * controller's `busy.delete`, which is where a `steer()` used to be
   * accepted and then stranded. Everything else here is the production
   * wiring: real `TurnController`, real `SteeringInbox`, real
   * `AgentLoop`, real `runtime.steer`. No sleeps, no timing luck.
   */
  it("refuses a steer that lands after the turn's final drain", async () => {
    const events: AgentLoopEvent[] = [];
    let inferences = 0;
    // Assigned right after bootstrap; the completer only runs inside a
    // turn, which is later still.
    let sessionId = "";
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      handlers: { onAgentEvent: (event) => events.push(event) },
      overrides: {
        browserBackend: new FakeBackend(),
        skipLlamaHealthCheck: true,
        llamaComplete: async () => {
          inferences += 1;
          if (inferences === 1) {
            // Sent while step 0's inference is in flight — the window
            // is open, so this one must be accepted AND delivered.
            expect(runtime.steer(sessionId, "check the logs first")).toBe(true);
            return completion(JSON.stringify({ tool: "noop", args: {} }));
          }
          return completion(
            JSON.stringify({ tool: "reply", args: { text: "done" } }),
          );
        },
      },
    });
    // A trivial non-terminal tool so the turn has a step boundary at
    // all; a one-step turn could not exercise steering.
    runtime.toolRegistry.register({
      name: "noop",
      description: "does nothing",
      readonly: true,
      run: async () => ({
        tool: "noop",
        status: "ok" as const,
        summary: "noop",
        details: {},
        truncated: false,
      }),
    });
    const session = runtime.createSession();
    sessionId = session.id;
    const lateSteerResults: boolean[] = [];
    try {
      const result = await runtime.turnController.enqueue({
        sessionId,
        origin: "tui",
        run: async () => {
          const r = await runtime.executeTurn(session, "do the thing", {
            maxSteps: 4,
          });
          // The loop has returned, so its final drain has happened.
          // The controller clears `busy` in its own `finally`, i.e.
          // after this body settles — so right here the two facts
          // disagree, and `isBusy` is the stale one.
          expect(runtime.turnController.isBusy(sessionId)).toBe(true);
          lateSteerResults.push(runtime.steer(sessionId, "too late, stop"));
          return r;
        },
      });

      // The in-flight steer landed where it should: a real user turn,
      // folded into the next step.
      expect(result.reason).toBe("reply");
      expect(
        result.session.turns
          .filter((t) => t.kind === "user")
          .map((t) => (t as { text: string }).text),
      ).toEqual(["do the thing", "check the logs first"]);
      expect(events).toContainEqual({
        type: "steer_applied",
        text: "check the logs first",
        stepIndex: 1,
      });

      // The late one did not. The caller is told "not steered" while
      // that is still true, so it can re-route...
      expect(lateSteerResults).toEqual([false]);
      // ...and nothing is left behind for a later turn to pick up.
      expect(runtime.steeringInbox.peek(sessionId)).toEqual([]);
      expect(result.undelivered).toEqual([]);

      // The symptom, spelled out: the next turn on this session must
      // not open with a "while you were working" notice about a turn
      // that ended before it started.
      events.length = 0;
      const tails: string[] = [];
      const next = await runtime.runTurn(result.session, "next question", {
        maxSteps: 4,
        eventHook: (event) => {
          if (
            event.type === "llm_event" &&
            event.event.type === "prompt_captured"
          ) {
            tails.push(event.event.tail);
          }
        },
      });
      expect(next.reason).toBe("reply");
      expect(events.filter((e) => e.type === "steer_applied")).toEqual([]);
      expect(tails.length).toBeGreaterThan(0);
      for (const tail of tails) expect(tail).not.toContain("too late, stop");
    } finally {
      await runtime.shutdown();
    }
  });

  it("drops pending steers on shutdown", async () => {
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: new FakeBackend(), skipLlamaHealthCheck: true },
    });
    const session = runtime.createSession();
    runtime.steeringInbox.open(session.id);
    runtime.steeringInbox.push(session.id, "stale");
    await runtime.shutdown();
    expect(runtime.steeringInbox.peek(session.id)).toEqual([]);
    // The window is closed too: nothing will ever drain it again.
    expect(runtime.steer(session.id, "after shutdown")).toBe(false);
  });
});

function completion(content: string): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

