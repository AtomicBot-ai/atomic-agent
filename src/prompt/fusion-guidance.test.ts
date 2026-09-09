import { describe, expect, it } from "vitest";

import {
  buildFusionGuidance,
  FUSION_DELEGATE_TOOL,
  FUSION_GUIDANCE,
  isFusionActive,
} from "./fusion-guidance.js";
import type { FusionMachineFacts } from "./fusion-machine-facts.js";
import { COMPOSIO_SEARCH_TOOL } from "./composio-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import type { CapabilitiesSummary } from "./capabilities.js";

function descriptor(name: string): ToolDescriptor {
  return { name, summary: `${name} summary`, argsSchema: "{}" };
}

const CAPS: CapabilitiesSummary = {
  platform: "linux",
} as unknown as CapabilitiesSummary;

const FACTS: FusionMachineFacts = { workerSlots: 4, workerModel: "qwen3-4b" };

function prefixWith(
  descriptors: readonly ToolDescriptor[],
  fusion?: FusionMachineFacts,
): string {
  return buildStablePrefix({
    toolDescriptors: descriptors,
    capabilities: CAPS,
    skillCatalog: [],
    ...(fusion === undefined ? {} : { fusion }),
  });
}

describe("isFusionActive", () => {
  it("keys off the delegate tool actually being mounted", () => {
    expect(isFusionActive([descriptor(FUSION_DELEGATE_TOOL)])).toBe(true);
    expect(isFusionActive([descriptor("os.fs.read")])).toBe(false);
    expect(isFusionActive([])).toBe(false);
  });
});

describe("the ### fusion prefix section", () => {
  it("is absent when the delegate tool is not mounted", () => {
    // A local- or cloud-only install must pay nothing for fusion: not a
    // token, not a byte of the KV-cached prefix — including the machine
    // facts, which are passed unconditionally by `buildPrompt`.
    const prefix = prefixWith([descriptor("os.fs.read")], FACTS);
    expect(prefix).not.toContain("### fusion");
    expect(prefix).not.toContain("worker agents");
    expect(prefix).not.toContain("qwen3-4b");
    expect(prefix).not.toContain("request slot");
  });

  it("appears once the delegate tool is mounted", () => {
    const prefix = prefixWith([
      descriptor("os.fs.read"),
      descriptor(FUSION_DELEGATE_TOOL),
    ]);
    expect(prefix).toContain("### fusion");
    expect(prefix).toContain(FUSION_GUIDANCE);
  });

  it("sits after integrations and before instructions", () => {
    const prefix = prefixWith([
      descriptor(COMPOSIO_SEARCH_TOOL),
      descriptor(FUSION_DELEGATE_TOOL),
    ]);
    expect(prefix.indexOf("### integrations")).toBeLessThan(
      prefix.indexOf("### fusion"),
    );
    expect(prefix.indexOf("### fusion")).toBeLessThan(
      prefix.indexOf("### instructions"),
    );
  });

  it("leaves everything above it byte-identical", () => {
    // Placement is load-bearing for the KV cache: persona, rules,
    // skills and the whole tools catalog must not move when fusion
    // turns on. (The catalog itself does gain the descriptor — compare
    // the head, which is what the cache key covers first.)
    const without = prefixWith([descriptor("os.fs.read")]);
    const with_ = prefixWith([descriptor("os.fs.read")]);
    expect(with_.slice(0, with_.indexOf("### capabilities"))).toBe(
      without.slice(0, without.indexOf("### capabilities")),
    );
  });

  it("tells the orchestrator to keep design and delegate bulk", () => {
    // The failure mode this guards is the inverted split: a model that
    // delegates the judgement and keeps the typing spends cloud tokens
    // on the bulk, which is the exact cost model fusion exists to undo.
    expect(FUSION_GUIDANCE).toContain("plan");
    expect(FUSION_GUIDANCE).toMatch(/Keep the design/i);
    expect(FUSION_GUIDANCE).toContain("`fusion.delegate`");
  });

  it("says a worker brief must stand alone", () => {
    expect(FUSION_GUIDANCE).toMatch(/stand alone|self-contained/i);
    expect(FUSION_GUIDANCE).toContain("no memory of this conversation");
  });

  it("says the call is solo and that results must be verified", () => {
    expect(FUSION_GUIDANCE).toMatch(/on its own, never alongside/i);
    expect(FUSION_GUIDANCE).toContain("needs_orchestrator");
  });

  it("stays short enough to live in every turn's prefix", () => {
    // Every byte here is paid on every step of every fusion turn.
    expect(FUSION_GUIDANCE.length).toBeLessThan(1400);
    expect(buildFusionGuidance(FACTS).length).toBeLessThan(1600);
  });
});

describe("the machine facts in the ### fusion block", () => {
  it("names the slot count, the local model and the resulting width", () => {
    // The orchestrator picks `maxWorkers` itself now. Choosing over
    // hardware it cannot see is guessing, so these are the three facts
    // that actually decide the number.
    const prefix = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], FACTS);
    expect(prefix).toContain("4 request slots");
    expect(prefix).toContain("`qwen3-4b`");
    expect(prefix).toContain("up to 4 run at once");
  });

  it("says nothing about a fact it does not have", () => {
    // An external llama-server's `--parallel` is nobody's business but
    // the operator's; a guessed slot count is worse than none, because
    // it is a number the model will plan against.
    const noSlots = buildFusionGuidance({
      workerSlots: null,
      workerModel: "qwen3-4b",
    });
    expect(noSlots).toContain("`qwen3-4b`");
    expect(noSlots).not.toContain("request slot");
    // Nothing known at all: the behavioural lines and not a word more.
    expect(
      buildFusionGuidance({ workerSlots: null, workerModel: null }),
    ).toBe(FUSION_GUIDANCE);
    expect(buildFusionGuidance()).toBe(FUSION_GUIDANCE);
  });

  it("singularises the one-slot case", () => {
    expect(
      buildFusionGuidance({ workerSlots: 1, workerModel: null }),
    ).toContain("1 request slot,");
  });

  it("is byte-identical across two builds with the same machine state", () => {
    // These bytes sit in the KV-cache-hot stable prefix: a timestamp, a
    // per-turn counter or a live pool size that resizes after the first
    // `/props` would drop the cache on every single step.
    const first = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], { ...FACTS });
    const second = prefixWith([descriptor(FUSION_DELEGATE_TOOL)], { ...FACTS });
    // Stability is only interesting if the facts are in there at all —
    // otherwise this passes on any build that renders nothing.
    expect(first).toContain("4 request slots");
    expect(second).toBe(first);
  });

  it("pushes the orchestrator to delegate, honestly", () => {
    // "It should always try to involve them more often" — but never at
    // the price of sending work that cannot succeed without the
    // conversation the worker will not have.
    expect(FUSION_GUIDANCE).toMatch(/prefer sending more/i);
    expect(FUSION_GUIDANCE).toContain("independent, self-contained parts");
    expect(FUSION_GUIDANCE).toMatch(/only makes sense with this conversation/i);
    // And the width is stated as the model's own call.
    expect(FUSION_GUIDANCE).toMatch(/You choose `maxWorkers`/);
  });
});
