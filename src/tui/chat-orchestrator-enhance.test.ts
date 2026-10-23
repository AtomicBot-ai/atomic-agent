import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "../session/session-state.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { PromptEnhanceResult } from "../runtime/prompt-enhancer.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { makeTuiEventBus } from "./make-event-bus.js";
import type { LocalTurnGateFacts } from "./local-turn-gate.js";
import type { TuiAction } from "./tui-action.js";

/** Hermetic gate facts: never read the developer's real config/disk. */
const cloudGateFacts = (): LocalTurnGateFacts => ({
  activeProviderIsLocal: false,
  managedMode: false,
  modelId: null,
  modelDownloaded: true,
  fallbackChainLength: 1,
});

type Enhance = NonNullable<AgentRuntime["enhancePrompt"]>;

function stubRuntime(enhancePrompt: Enhance | undefined): AgentRuntime {
  const session = () => createEmptySessionState({ id: "s1", workingDir: "/tmp" });
  return {
    createSession: session,
    capabilities: { workingDir: "/tmp" },
    getSessionWorkspace: () => null,
    skillRegistry: { listAll: () => [] },
    skillCatalogDropped: 0,
    steer: () => false,
    // A turn that runs until aborted, so a session exists while it does.
    runTurn: (_s: unknown, _text: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    turnController: { isBusy: () => false },
    sessionStore: {
      listSummaryPage: () => [],
      countUnreadable: () => 0,
      listRecent: () => [],
      load: () => null,
    },
    approvals: { clearSessionGrants: () => undefined },
    config: {
      update: { checkOnStartup: false, repo: "x/y" },
      tracing: { trace: { dir: "/tmp", enabled: false } },
    },
    profileStore: { list: () => [] },
    skillCatalog: [],
    ...(enhancePrompt ? { enhancePrompt } : {}),
  } as unknown as AgentRuntime;
}

function setup(enhancePrompt: Enhance | undefined) {
  const bus = makeTuiEventBus();
  const actions: TuiAction[] = [];
  bus.subscribe((a) => actions.push(a));
  const orchestrator = new ChatOrchestrator(stubRuntime(enhancePrompt), bus, {
    maxSteps: 5,
    llamaUrl: "http://127.0.0.1:8080",
    readGateFacts: cloudGateFacts,
  });
  return { orchestrator, actions };
}

function notices(actions: readonly TuiAction[]): string[] {
  return actions.flatMap((a) => (a.type === "composer_notice" && a.text !== null ? [a.text] : []));
}

/** An enhance call that only settles when its signal aborts. */
function hangingEnhance(): Enhance {
  return (_draft, options) =>
    new Promise<PromptEnhanceResult>((resolve) => {
      options?.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" }), { once: true });
    });
}

describe("ChatOrchestrator /enhance", () => {
  it("hands the rewrite to the composer, guarded by the original draft", async () => {
    const enhance = vi.fn<Enhance>(async () => ({ ok: true, text: "Fix the login bug." }));
    const { orchestrator, actions } = setup(enhance);
    await orchestrator.enhancePrompt("fix login");
    expect(actions).toContainEqual({ type: "composer_draft_replaced", expected: "fix login", value: "Fix the login bug." });
    expect(enhance.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes the open session's id for the partition", async () => {
    const enhance = vi.fn<Enhance>(async () => ({ ok: true, text: "Rewritten." }));
    const { orchestrator } = setup(enhance);
    orchestrator.sendMessage("open a session");
    await orchestrator.enhancePrompt("draft");
    expect(enhance.mock.calls[0]?.[1]?.sessionId).toBe("s1");
    orchestrator.abortCurrentTurn();
  });

  it("refuses a second enhance while one is running", async () => {
    const { orchestrator, actions } = setup(hangingEnhance());
    const first = orchestrator.enhancePrompt("one");
    await orchestrator.enhancePrompt("two");
    expect(notices(actions)).toContain("Already enhancing a prompt; wait for it to finish.");
    orchestrator.abortCurrentTurn();
    await first;
  });

  it("keeps the draft and says why on a failure", async () => {
    const { orchestrator, actions } = setup(async () => ({ ok: false, reason: "timed out" }));
    await orchestrator.enhancePrompt("draft");
    expect(notices(actions)).toContain("Could not enhance the prompt (timed out). Your text is unchanged.");
    expect(actions.some((a) => a.type === "composer_draft_replaced")).toBe(false);
  });

  it("keeps the draft and says why when the runtime throws", async () => {
    const { orchestrator, actions } = setup(async () => {
      throw new Error("boom");
    });
    await orchestrator.enhancePrompt("draft");
    expect(notices(actions)).toContain("Could not enhance the prompt (boom). Your text is unchanged.");
  });

  it("says so when the runtime does not offer enhancement", async () => {
    const { orchestrator, actions } = setup(undefined);
    await orchestrator.enhancePrompt("draft");
    expect(notices(actions)).toContain("Prompt enhancement is not available here.");
  });

  it("aborts the running enhance when a message is sent, and stays quiet", async () => {
    let signal: AbortSignal | undefined;
    const hanging = hangingEnhance();
    const { orchestrator, actions } = setup((draft, options) => {
      signal = options?.signal;
      return hanging(draft, options);
    });
    const pending = orchestrator.enhancePrompt("draft");
    orchestrator.sendMessage("draft");
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(actions.some((a) => a.type === "composer_draft_replaced")).toBe(false);
    expect(notices(actions).some((n) => n.startsWith("Could not enhance"))).toBe(false);
    orchestrator.abortCurrentTurn();
  });

  it("aborts the running enhance on Esc, and a new one can start after", async () => {
    const signals: AbortSignal[] = [];
    const hanging = hangingEnhance();
    const { orchestrator } = setup((draft, options) => {
      if (options?.signal) signals.push(options.signal);
      return hanging(draft, options);
    });
    const first = orchestrator.enhancePrompt("one");
    orchestrator.abortCurrentTurn();
    await first;
    const second = orchestrator.enhancePrompt("two");
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    orchestrator.abortCurrentTurn();
    await second;
  });
});
