import type { AtomicAgentConfig } from "../../config/index.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import {
  createModelRiskReviewer,
  type RiskReviewCompletionParams,
} from "../../approval/risk-review.js";
import type { ToolCallTransport } from "../../llm/provider/completion-types.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { ResolvedLlmConfig } from "../../llm/provider/registry/provider-types.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { isLocalLinkWithoutModel } from "../local-link-availability.js";

/**
 * The provider the smart-approval review runs on, or `undefined` for the
 * active one:
 *
 *  1. `agent.smartApprovalModel`, the id of an `llm.providers` entry, when
 *     it names one that exists;
 *  2. otherwise a `llama-server` link with a model to serve, so the
 *     review stays on this machine and costs nothing even when the turn
 *     itself runs on a cloud model;
 *  3. otherwise the active provider.
 *
 * Read per review, so a provider or model switch applies at once.
 */
export function resolveRiskReviewProvider(
  cfg: AtomicAgentConfig,
  llm: ResolvedLlmConfig = resolveLlmConfig(cfg),
  localWithoutModel: (llm: ResolvedLlmConfig, id: string) => boolean = (l, id) =>
    isLocalLinkWithoutModel(l, id, cfg),
): string | undefined {
  const pinned = cfg.agent.smartApprovalModel;
  if (pinned !== null && llm.providers.some((p) => p.id === pinned)) return pinned;
  const local = llm.providers.find(
    (p) => p.kind === "llama-server" && !localWithoutModel(llm, p.id),
  );
  return local?.id;
}

export interface RiskReviewWiring {
  approvals: Pick<ApprovalGate, "setRiskReviewer">;
  readConfig: () => AtomicAgentConfig;
  complete: (params: RiskReviewCompletionParams) => Promise<CompletionResult>;
  resolveTransport: (providerId: string | undefined) => ToolCallTransport;
  sideCallSlotId: () => number;
  /** The running turn's request on a session (`turnRequests` in bootstrap). */
  userRequest: (sessionId: string) => string | undefined;
  logger: StructuredLogger;
}

/**
 * Install the reviewer on the gate. Always installed; `agent.smartApproval`
 * (read live) decides whether the gate consults it, so turning the setting
 * on or off needs no restart.
 */
export function installRiskReviewer(wiring: RiskReviewWiring): void {
  wiring.approvals.setRiskReviewer(
    createModelRiskReviewer({
      enabled: () => wiring.readConfig().agent.smartApproval,
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
      serverTemplate: () =>
        wiring.readConfig().localModels.useServerTemplate !== "off",
      userRequest: wiring.userRequest,
      onError: (err: unknown) =>
        wiring.logger.debug("smart approval risk review gave no verdict", {
          error: err instanceof Error ? err.message : String(err),
        }),
    }),
  );
}
