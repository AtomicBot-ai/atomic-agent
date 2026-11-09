import { describe, expect, it, vi } from "vitest";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { RiskReviewer } from "../../approval/risk-review.js";
import { installRiskReviewer, resolveRiskReviewProvider } from "./runtime-risk-review.js";

function cfg(agent: { smartApproval?: boolean; smartApprovalModel?: string | null }): AtomicAgentConfig {
  return {
    agent: { smartApproval: false, smartApprovalModel: null, ...agent },
    localModels: { useServerTemplate: "auto" },
  } as unknown as AtomicAgentConfig;
}

const llm = {
  activeTextProvider: "cloud",
  providers: [
    { id: "cloud", kind: "openai-compatible" },
    { id: "local-llama", kind: "llama-server" },
  ],
} as unknown as ResolvedLlmConfig;

describe("resolveRiskReviewProvider", () => {
  it("uses agent.smartApprovalModel when it names a provider", () => {
    expect(resolveRiskReviewProvider(cfg({ smartApprovalModel: "cloud" }), llm, () => false)).toBe("cloud");
  });

  it("ignores an unknown pinned id and prefers a local link that has a model", () => {
    expect(resolveRiskReviewProvider(cfg({ smartApprovalModel: "gone" }), llm, () => false)).toBe("local-llama");
  });

  it("falls back to the active provider when the local link has no model", () => {
    expect(resolveRiskReviewProvider(cfg({}), llm, () => true)).toBeUndefined();
  });
});

describe("installRiskReviewer", () => {
  it("installs a reviewer whose switch follows agent.smartApproval live", () => {
    let current = cfg({ smartApproval: false });
    let installed: RiskReviewer | undefined;
    installRiskReviewer({
      approvals: { setRiskReviewer: (r) => (installed = r) },
      readConfig: () => current,
      complete: vi.fn(),
      resolveTransport: () => "grammar",
      sideCallSlotId: () => 0,
      userRequest: () => undefined,
      logger: { debug: vi.fn() } as never,
    });
    expect(installed?.enabled?.()).toBe(false);
    current = cfg({ smartApproval: true });
    expect(installed?.enabled?.()).toBe(true);
  });
});
