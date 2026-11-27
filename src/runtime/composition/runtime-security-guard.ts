import type { AtomicAgentConfig } from "../../config/index.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import { createModelGuardReviewer } from "../../approval/guard-review.js";
import { GuardRulesSource } from "../../approval/guard-rules.js";
import type { RiskReviewCompletionParams } from "../../approval/risk-review.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { resolveRiskReviewProvider } from "./runtime-risk-review.js";

export interface SecurityGuardWiring {
  approvals: Pick<ApprovalGate, "setGuard">;
  stateDir: string;
  readConfig: () => AtomicAgentConfig;
  complete: (params: RiskReviewCompletionParams) => Promise<CompletionResult>;
  resolveTransport: (providerId: string | undefined) => ToolCallTransport;
  sideCallSlotId: () => number;
  userRequest: (sessionId: string) => string | undefined;
  logger: StructuredLogger;
}

/**
 * Install plain-text security rules (ATO-2111) on the gate. Always
 * installed; it does anything only while `<stateDir>/guard.md` or a
 * project's `.atomic-agent/guard.md` exists, read per call. The review
 * runs on the smart-approval model (`agent.smartApprovalModel`, else a
 * local model, else the session's), see `resolveRiskReviewProvider`.
 */
export function installSecurityGuard(wiring: SecurityGuardWiring): void {
  const source = new GuardRulesSource(wiring.stateDir);
  wiring.approvals.setGuard({
    rules: (workdir) => source.load(workdir),
    review: createModelGuardReviewer({
      providerId: () => resolveRiskReviewProvider(wiring.readConfig()),
      transport: (providerId) => wiring.resolveTransport(providerId),
      complete: async (params) => {
        const result = await wiring.complete(params);
        return {
          content: result.content,
          ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
        };
      },
      slotId: () => wiring.sideCallSlotId(),
      serverTemplate: () => wiring.readConfig().localModels.useServerTemplate !== "off",
      userRequest: wiring.userRequest,
      onError: (err: unknown) =>
        wiring.logger.debug("security rules review gave no verdict", {
          error: err instanceof Error ? err.message : String(err),
        }),
    }),
  });
}
