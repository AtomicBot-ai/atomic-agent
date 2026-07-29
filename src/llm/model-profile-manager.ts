import type { StructuredLogger } from "../tracing/structured-logger.js";
import { buildGrammar } from "./grammar/build-grammar.js";
import type { LlamaServerClient } from "./llama-server-client.js";
import {
  detectModelProfile,
  extractTotalSlots,
  type ModelProfile,
} from "./model-profile.js";
import { checkProfileGrammarAligned } from "./profile-invariants.js";

export interface ModelProfileManagerOptions {
  llama: LlamaServerClient;
  initialProfile: ModelProfile;
  initialGrammar: string;
  /**
   * Last known model identifier — either the `model_alias` reported by
   * `/props`, or the `model` field echoed by the completion endpoint.
   * `null` means the initial probe failed and we are running on the
   * plain-instruct fallback.
   */
  initialModelId: string | null;
  grammarsDir?: string;
  /**
   * Mirrors `config.browser.enabled`. Threaded into every grammar rebuild
   * on hot-swap so a disabled browser surface stays structurally forbidden
   * after the model changes — without it, a swap would silently re-admit
   * `browser.*` into the `tool-name` rule. Default `true`.
   */
  browserEnabled?: boolean;
  /**
   * Invoked with `/props.total_slots` after every successful probe.
   * Managed mode defers the boot health check (the daemon may not be
   * running yet), so bootstrap builds the `SlotManager` on a conservative
   * one-slot default; this is the hook that widens it to the server's
   * real `--parallel` count on the first refresh. Omit to ignore slot
   * discovery entirely (tests with a stubbed HTTP layer).
   */
  onTotalSlots?: (totalSlots: number) => void;
  logger?: StructuredLogger;
}

export interface ModelProfileRefreshResult {
  /** True when the refresh swapped the active profile (id changed). */
  profileChanged: boolean;
  /** Active profile id after the refresh (unchanged when probe failed). */
  profileId: ModelProfile["id"];
  /** Active model id after the refresh. `null` when unknown. */
  modelId: string | null;
}

/**
 * Owns the mutable side of the model wiring: current `ModelProfile`, the
 * matching GBNF grammar, and the last known `model_alias` returned by the
 * server. Lets the agent recover when the operator hot-swaps the model
 * behind `llama-server` without restarting atomic-agent.
 *
 * Two detection paths feed into the manager:
 *  - `observeCompletionModelId(id)` — cheap check after every LLM call;
 *    a mismatch marks the manager stale without blocking the current
 *    step.
 *  - `refresh()` / `refreshIfStale()` — async re-probe of `/props` that
 *    rebuilds the grammar when the profile id actually changed. The
 *    agent loop calls `refresh()` at turn start (proactive) and
 *    `refreshIfStale()` between steps (reactive).
 *
 * Refresh failures are swallowed with a warning so a transient network
 * blip cannot tear down an in-flight turn; the prior profile stays
 * active until the next probe succeeds.
 */
export class ModelProfileManager {
  private profile: ModelProfile;
  private grammar: string;
  private modelId: string | null;
  private stale = false;
  private readonly llama: LlamaServerClient;
  private readonly grammarsDir: string | undefined;
  private readonly browserEnabled: boolean;
  private readonly onTotalSlots:
    | ((totalSlots: number) => void)
    | undefined;
  private readonly logger: StructuredLogger | undefined;

  constructor(options: ModelProfileManagerOptions) {
    this.profile = options.initialProfile;
    this.grammar = options.initialGrammar;
    this.modelId = normaliseId(options.initialModelId);
    this.llama = options.llama;
    this.grammarsDir = options.grammarsDir;
    this.browserEnabled = options.browserEnabled ?? true;
    this.onTotalSlots = options.onTotalSlots;
    this.logger = options.logger;
  }

  getProfile(): ModelProfile {
    return this.profile;
  }

  getGrammar(): string {
    return this.grammar;
  }

  getModelId(): string | null {
    return this.modelId;
  }

  isStale(): boolean {
    return this.stale;
  }

  /**
   * Note the `modelId` carried by a completion response. When it differs
   * from the active baseline, the manager flags itself stale so the next
   * `refreshIfStale()` forces a re-probe. Null / empty ids are ignored
   * because older llama.cpp builds omit the `model` field entirely.
   */
  observeCompletionModelId(modelId: string | null): void {
    const incoming = normaliseId(modelId);
    if (incoming === null) return;
    if (this.modelId === null) {
      this.modelId = incoming;
      return;
    }
    if (this.modelId !== incoming) {
      this.stale = true;
    }
  }

  async refreshIfStale(): Promise<ModelProfileRefreshResult> {
    if (!this.stale) {
      return {
        profileChanged: false,
        profileId: this.profile.id,
        modelId: this.modelId,
      };
    }
    return this.refresh();
  }

  /**
   * Re-probe `/props`, re-detect the profile, and rebuild the grammar
   * when the profile id changed. Always clears the stale flag so a
   * persistently broken server cannot trap us in a refresh loop — the
   * next completion mismatch will re-arm it.
   */
  async refresh(): Promise<ModelProfileRefreshResult> {
    try {
      const props = await this.llama.fetchProps();
      // Slot discovery rides this probe. Done before the profile work so a
      // grammar rebuild failure cannot swallow it — an oversized slot pool
      // silently thrashes the server's KV cache and is worth correcting
      // even on a turn where nothing else changed.
      const totalSlots = extractTotalSlots(props);
      if (totalSlots !== null) {
        this.onTotalSlots?.(totalSlots);
      }
      const nextProfile = detectModelProfile(props);
      const nextModelId = normaliseId(
        typeof props.model_alias === "string" ? props.model_alias : null,
      );
      const profileChanged = nextProfile.id !== this.profile.id;
      if (profileChanged) {
        const nextGrammar = await buildGrammar(nextProfile, this.grammarsDir, {
          browserEnabled: this.browserEnabled,
        });
        const violations = checkProfileGrammarAligned(nextProfile, nextGrammar);
        if (violations.length > 0) {
          this.logger?.warn("refreshed profile/grammar invariant violated", {
            profile: nextProfile.id,
            violations,
          });
        }
        this.profile = nextProfile;
        this.grammar = nextGrammar;
        this.logger?.info("model profile hot-swapped", {
          from: this.profile.id === nextProfile.id ? null : this.profile.id,
          to: nextProfile.id,
          modelId: nextModelId,
        });
      }
      if (nextModelId !== null) {
        this.modelId = nextModelId;
      }
      this.stale = false;
      return {
        profileChanged,
        profileId: this.profile.id,
        modelId: this.modelId,
      };
    } catch (err) {
      this.logger?.warn("model profile refresh failed; keeping prior profile", {
        error: err instanceof Error ? err.message : String(err),
        profile: this.profile.id,
      });
      this.stale = false;
      return {
        profileChanged: false,
        profileId: this.profile.id,
        modelId: this.modelId,
      };
    }
  }
}

function normaliseId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
