import type { StructuredLogger } from "../tracing/structured-logger.js";
import { readModelPrefixReuse } from "../local-llm/gguf-metadata.js";
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
  /**
   * Where the managed daemon's start-time throughput probe left its
   * reading (`readThroughputRecord` in `daemon-lifecycle.ts`), consulted
   * while the manager holds no figure of its own: the daemon may have
   * been started by another process (`models start`) or after this
   * runtime booted. Omit when the server is external — nothing measured
   * it.
   */
  readThroughput?: () => number | null;
  /**
   * Reads the prefix-reuse verdict for the model file `/props.model_path`
   * names. Defaults to `readModelPrefixReuse` (a bounded GGUF header
   * read, memoised per path); tests inject a stub. `null` from it keeps
   * the profile's default (`"partial"`).
   */
  readPrefixReuse?: (modelPath: string) => Promise<{
    prefixReuse: "partial" | "none";
    reasons: string[];
  } | null>;
  /**
   * Whether the daemon was launched with `--swa-full`, which makes a
   * sliding-window model's cache partially reusable again. Read per
   * refresh; absent means unknown (treated as not set).
   */
  swaFullActive?: () => boolean;
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
  /** Single-stream decode speed of the serving daemon, tokens per second. */
  private tokensPerSecond: number | null = null;
  private readonly llama: LlamaServerClient;
  private readonly grammarsDir: string | undefined;
  private readonly browserEnabled: boolean;
  private readonly onTotalSlots: ((totalSlots: number) => void) | undefined;
  private readonly readThroughput: (() => number | null) | undefined;
  private readonly readPrefixReuse: NonNullable<
    ModelProfileManagerOptions["readPrefixReuse"]
  >;
  private readonly swaFullActive: (() => boolean) | undefined;
  private readonly logger: StructuredLogger | undefined;

  constructor(options: ModelProfileManagerOptions) {
    this.profile = options.initialProfile;
    this.grammar = options.initialGrammar;
    this.modelId = normaliseId(options.initialModelId);
    this.llama = options.llama;
    this.grammarsDir = options.grammarsDir;
    this.browserEnabled = options.browserEnabled ?? true;
    this.onTotalSlots = options.onTotalSlots;
    this.readThroughput = options.readThroughput;
    this.readPrefixReuse = options.readPrefixReuse ?? readModelPrefixReuse;
    this.swaFullActive = options.swaFullActive;
    this.logger = options.logger;
  }

  getProfile(): ModelProfile {
    return this.profile;
  }

  /**
   * What the serving daemon generates at, single stream — the start-time
   * probe's reading, or `null` while nothing has measured it. Consults
   * the daemon's record when nothing is held, so a daemon started by
   * another process is read the first time anyone asks.
   */
  getTokensPerSecond(): number | null {
    if (this.tokensPerSecond === null && this.readThroughput) {
      const recorded = this.readThroughput();
      if (recorded !== null && Number.isFinite(recorded) && recorded > 0) {
        this.tokensPerSecond = recorded;
      }
    }
    return this.tokensPerSecond;
  }

  /**
   * Record a measured decode speed — the start-time probe result handed
   * over by whoever started the daemon in this process. Non-positive or
   * non-finite readings are ignored rather than stored as nonsense.
   */
  observeThroughput(tokensPerSecond: number | null): void {
    if (
      tokensPerSecond !== null &&
      Number.isFinite(tokensPerSecond) &&
      tokensPerSecond > 0
    ) {
      this.tokensPerSecond = tokensPerSecond;
    }
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

  /**
   * Stamp `prefixReuse` on a freshly detected profile from the model
   * file `/props.model_path` names — the one async step of a refresh.
   * No path, an unreadable header, or a non-GGUF file keeps the
   * profile's default.
   */
  private async applyPrefixReuse(
    profile: ModelProfile,
    modelPath: string | null,
  ): Promise<ModelProfile> {
    if (modelPath === null || modelPath.length === 0) return profile;
    const verdict = await this.readPrefixReuse(modelPath);
    if (verdict === null) return profile;
    // `--swa-full` makes a sliding-window model's cache partially
    // reusable again; a hybrid's recurrent state stays whole-or-nothing.
    const hybrid = verdict.reasons.some((r) => r.startsWith("hybrid"));
    const prefixReuse: "partial" | "none" =
      verdict.prefixReuse === "none" &&
      this.swaFullActive?.() === true &&
      !hybrid
        ? "partial"
        : verdict.prefixReuse;
    if (prefixReuse !== (this.profile.prefixReuse ?? "partial")) {
      this.logger?.info("model prefix reuse resolved from header", {
        modelPath,
        prefixReuse,
        reasons: verdict.reasons,
      });
    }
    return { ...profile, prefixReuse };
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
      const nextProfile = await this.applyPrefixReuse(
        detectModelProfile(props),
        typeof props.model_path === "string" ? props.model_path : null,
      );
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
      } else if (nextProfile.prefixReuse !== this.profile.prefixReuse) {
        // Same profile id, but the header now says something about
        // reuse — the grammar is untouched, the packer's input is not.
        this.profile = { ...this.profile, prefixReuse: nextProfile.prefixReuse };
      }
      if (nextModelId !== null) {
        this.modelId = nextModelId;
      }
      // A refresh is where a restarted daemon becomes visible; re-read
      // its record so the speed follows the instance, not the process.
      if (this.readThroughput) {
        const recorded = this.readThroughput();
        this.tokensPerSecond =
          recorded !== null && Number.isFinite(recorded) && recorded > 0
            ? recorded
            : profileChanged
              ? null
              : this.tokensPerSecond;
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
