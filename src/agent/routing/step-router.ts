import type { RunModeSubRunners } from "../../config/llm-run-mode-config.js";
import { computeStepComplexity } from "./compute-step-complexity.js";
import { decideRoutingRole, type RoutingRole } from "./decide-routing-role.js";

/**
 * Live fusion parameters. Re-read before every step so a mode switch or
 * a dial change made in the TUI takes effect on the next inference
 * rather than at the next process start — the same late-binding
 * discipline `bootstrap` uses for `toolTransport` and slot affinity.
 */
export interface FusionRoutingSnapshot {
  cloudProviderId: string;
  localProviderId: string;
  cloudShare: number;
  subRunners: RunModeSubRunners;
  maxSteps: number;
  conversationMaxTokens: number;
}

export interface StepRouterDeps {
  /** Returns `null` whenever the effective run mode is not fusion. */
  resolveFusion: () => FusionRoutingSnapshot | null;
}

export interface RouteStepArgs {
  sessionId: string;
  stepIndex: number;
  promptTokens: number;
  stablePrefixTokens: number;
  hasTransientNotice: boolean;
}

export interface StepRouting {
  role: RoutingRole;
  providerId: string;
  complexity: number;
  cloudShare: number;
}

/**
 * Bound on the per-session role memory. Only exists so a long-lived
 * `serve` process cannot accumulate one entry per session forever;
 * eviction is oldest-first, and losing an entry costs nothing but one
 * step of hysteresis.
 */
const MAX_TRACKED_SESSIONS = 256;

/**
 * Chooses the fusion leg for each inference.
 *
 * Deliberately thin: scoring and the cutoff rule live in the two pure
 * modules beside it, so the only thing here is the per-session memory
 * that hysteresis needs.
 *
 * Note what is NOT here: repair-retry stickiness. The parse-repair call
 * in `step-executor` spreads the original `LlmStreamParams`, so it
 * inherits `preferredProviderId` from the attempt it is repairing for
 * free — which is exactly the required behaviour, since a repair must
 * be judged by the model that made the mistake and against the same
 * transport.
 */
export class StepRouter {
  private readonly resolveFusion: StepRouterDeps["resolveFusion"];
  private readonly lastRole = new Map<string, RoutingRole>();

  constructor(deps: StepRouterDeps) {
    this.resolveFusion = deps.resolveFusion;
  }

  /** `null` ⇒ not in fusion; the caller leaves provider selection alone. */
  routeStep(args: RouteStepArgs): StepRouting | null {
    const fusion = this.resolveFusion();
    if (!fusion) {
      this.lastRole.delete(args.sessionId);
      return null;
    }
    const complexity = computeStepComplexity({
      promptTokens: args.promptTokens,
      stablePrefixTokens: args.stablePrefixTokens,
      stepIndex: args.stepIndex,
      hasTransientNotice: args.hasTransientNotice,
      maxSteps: fusion.maxSteps,
      conversationMaxTokens: fusion.conversationMaxTokens,
    });
    const role = decideRoutingRole({
      score: complexity,
      cloudShare: fusion.cloudShare,
      stepIndex: args.stepIndex,
      previousRole: this.lastRole.get(args.sessionId) ?? null,
    });
    this.remember(args.sessionId, role);
    return {
      role,
      providerId:
        role === "orchestrator"
          ? fusion.cloudProviderId
          : fusion.localProviderId,
      complexity,
      cloudShare: fusion.cloudShare,
    };
  }

  /**
   * Provider for a memory sub-runner (reflection, link generation,
   * curation votes, query rewriting, distillation).
   *
   * `local` by default: these are cold-path structured-JSON jobs that
   * ride the reserved reflection slot and are already KV-warm on the
   * local server, so routing them to the cloud multiplies per-turn cost
   * with no user-visible latency win. `follow` reuses the leg the last
   * main-loop step of that session used.
   */
  subRunnerProviderId(sessionId?: string): string | null {
    const fusion = this.resolveFusion();
    if (!fusion) return null;
    const target: RunModeSubRunners = fusion.subRunners;
    if (target === "cloud") return fusion.cloudProviderId;
    if (target === "local") return fusion.localProviderId;
    const last = sessionId ? this.lastRole.get(sessionId) : undefined;
    return last === "orchestrator"
      ? fusion.cloudProviderId
      : fusion.localProviderId;
  }

  /** Drop a finished session's hysteresis memory. */
  forgetSession(sessionId: string): void {
    this.lastRole.delete(sessionId);
  }

  private remember(sessionId: string, role: RoutingRole): void {
    // Re-insert so the Map's insertion order doubles as recency.
    this.lastRole.delete(sessionId);
    this.lastRole.set(sessionId, role);
    while (this.lastRole.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.lastRole.keys().next();
      if (oldest.done === true) break;
      this.lastRole.delete(oldest.value);
    }
  }
}
