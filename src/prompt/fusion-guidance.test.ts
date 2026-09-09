import { describe, expect, it } from "vitest";

import {
  FUSION_DELEGATE_TOOL,
  FUSION_GUIDANCE,
  isFusionActive,
} from "./fusion-guidance.js";
import { COMPOSIO_SEARCH_TOOL } from "./composio-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import type { CapabilitiesSummary } from "./capabilities.js";

function descriptor(name: string): ToolDescriptor {
  return { name, summary: `${name} summary`, argsSchema: "{}" };
}

const CAPS: CapabilitiesSummary = {
  platform: "linux",
} as unknown as CapabilitiesSummary;

function prefixWith(descriptors: readonly ToolDescriptor[]): string {
  return buildStablePrefix({
    toolDescriptors: descriptors,
    capabilities: CAPS,
    skillCatalog: [],
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
    // token, not a byte of the KV-cached prefix.
    const prefix = prefixWith([descriptor("os.fs.read")]);
    expect(prefix).not.toContain("### fusion");
    expect(prefix).not.toContain("worker agents");
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
    expect(FUSION_GUIDANCE.length).toBeLessThan(1400);
  });
});
