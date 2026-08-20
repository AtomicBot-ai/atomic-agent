import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { executeStep } from "./step-executor.js";
import type { LlmStreamParams, StepDependencies } from "./step-executor.js";
import type { StepEvent } from "./step-events.js";
import { StepRouter, type FusionRoutingSnapshot } from "./routing/index.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { compressToolResult } from "../compressor/result-compressor.js";
import { SlotManager } from "../llm/slot-manager.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import { buildGrammar } from "../llm/grammar/build-grammar.js";
import { createEmptySessionState } from "../session/session-state.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../prompt/tool-descriptors.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
} from "../prompt/stable-prefix.js";

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};
const SKILLS: SkillCatalogEntry[] = [];

const FUSION: FusionRoutingSnapshot = {
  cloudProviderId: "cloud",
  localProviderId: "local",
  cloudShare: 40,
  subRunners: "local",
  maxSteps: 25,
  conversationMaxTokens: 32_000,
};

function replyRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "reply",
    description: "reply",
    readonly: true,
    async run(args: Record<string, unknown>) {
      return compressToolResult({
        tool: "reply",
        status: "ok",
        output: String(args.text ?? ""),
      });
    },
  });
  return registry;
}

function completion(content: string) {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 20, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: "mock",
  };
}

const REPLY_BODY = JSON.stringify({ tool: "reply", args: { text: "done" } });

/**
 * Run one step and report what the LLM seam actually received, plus the
 * events the step emitted.
 */
async function runStep(opts: {
  router?: StepRouter;
  resolveSlotAffinity?: (providerId: string) => boolean;
  supportsSlotAffinity?: boolean;
  bodies?: string[];
}): Promise<{ seen: LlmStreamParams[]; events: StepEvent[] }> {
  const grammar = await buildGrammar(
    PLAIN_INSTRUCT_PROFILE,
    join(process.cwd(), "grammars"),
  );
  const seen: LlmStreamParams[] = [];
  const events: StepEvent[] = [];
  const bodies = opts.bodies ?? [REPLY_BODY];
  let call = 0;

  const deps = {
    registry: replyRegistry(),
    slotManager: new SlotManager(2),
    llmComplete: async (params: LlmStreamParams) => {
      seen.push(params);
      const body = bodies[Math.min(call, bodies.length - 1)]!;
      call += 1;
      return completion(body);
    },
    grammar,
    profile: PLAIN_INSTRUCT_PROFILE,
    supportsSlotAffinity: opts.supportsSlotAffinity ?? false,
    onEvent: (event: StepEvent) => events.push(event),
    ...(opts.router ? { stepRouter: opts.router } : {}),
    ...(opts.resolveSlotAffinity
      ? { resolveSlotAffinity: opts.resolveSlotAffinity }
      : {}),
  } as unknown as StepDependencies;

  await executeStep(
    {
      session: createEmptySessionState({ id: "s-route", workingDir: "/w" }),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      stepIndex: 0,
      signal: new AbortController().signal,
      userMessage: "x",
    },
    deps,
  );
  return { seen, events };
}

const routerWith = (over: Partial<FusionRoutingSnapshot> = {}): StepRouter =>
  new StepRouter({ resolveFusion: () => ({ ...FUSION, ...over }) });

describe("executeStep fusion routing", () => {
  it("sets no preferredProviderId when no router is wired", async () => {
    const { seen, events } = await runStep({});
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("preferredProviderId");
    expect(events.some((e) => e.type === "step_routed")).toBe(false);
  });

  it("sets no preferredProviderId when the router declines (not fusion)", async () => {
    const router = new StepRouter({ resolveFusion: () => null });
    const { seen, events } = await runStep({ router });
    expect(seen[0]).not.toHaveProperty("preferredProviderId");
    expect(events.some((e) => e.type === "step_routed")).toBe(false);
  });

  it("forwards the routed provider to the LLM seam", async () => {
    // Step 0 always orchestrates ⇒ the cloud leg.
    const { seen } = await runStep({ router: routerWith() });
    expect(seen[0]?.preferredProviderId).toBe("cloud");
  });

  it("forwards the local leg when the dial is fully local", async () => {
    const { seen } = await runStep({ router: routerWith({ cloudShare: 0 }) });
    expect(seen[0]?.preferredProviderId).toBe("local");
  });

  it("emits step_routed describing the decision", async () => {
    const { events } = await runStep({ router: routerWith() });
    const routed = events.find((e) => e.type === "step_routed");
    expect(routed).toMatchObject({
      type: "step_routed",
      stepIndex: 0,
      role: "orchestrator",
      providerId: "cloud",
      cloudShare: 40,
    });
  });

  it("acquires a real slot when the ROUTED provider has slot affinity", async () => {
    // The active provider reports no affinity (cloud), but the step is
    // routed to the local leg, which does. Without `resolveSlotAffinity`
    // this would run at slotId -1 and reprocess the whole prompt.
    const { seen } = await runStep({
      router: routerWith({ cloudShare: 0 }),
      supportsSlotAffinity: false,
      resolveSlotAffinity: (id) => id === "local",
    });
    expect(seen[0]?.slotId).toBeGreaterThanOrEqual(0);
  });

  it("drops to slotId -1 when the routed provider has no slot affinity", async () => {
    const { seen } = await runStep({
      router: routerWith({ cloudShare: 100 }),
      supportsSlotAffinity: true,
      resolveSlotAffinity: (id) => id === "local",
    });
    expect(seen[0]?.preferredProviderId).toBe("cloud");
    expect(seen[0]?.slotId).toBe(-1);
  });

  it("repairs on the same leg that produced the malformed call", async () => {
    const { seen } = await runStep({
      router: routerWith({ cloudShare: 0 }),
      bodies: ["not json at all", REPLY_BODY],
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // A repair judged by the OTHER leg would parse a different model's
    // mistake against a different transport.
    expect(seen[1]?.preferredProviderId).toBe("local");
  });
});
