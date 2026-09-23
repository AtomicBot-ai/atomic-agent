import type { ModelProfile } from "../llm/model-profile.js";
import type {
  PromptMessages,
  ToolCallTransport,
} from "../llm/provider/completion-types.js";
import type { ThinkingSetting } from "../llm/server-template-policy.js";
import type { ProfileFact } from "../memory/profile-store.js";
import type { ProfileClipStats } from "./clip-profile-section.js";
import type { ConversationPackStart } from "../session/conversation-turn.js";
import type { SessionState } from "../session/session-state.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import type { TokenBudgetLimits } from "./token-budget.js";
import type { ToolRole } from "../tools/tool-roles.js";

export interface BuildPromptInput {
  session: SessionState;
  toolDescriptors: readonly ToolDescriptor[];
  capabilities: CapabilitiesSummary;
  skillCatalog: readonly SkillCatalogEntry[];
  /**
   * Installed skills the catalog budget left out. Forwarded into
   * `buildStablePrefix`, which ends `### skills` on a truncation marker
   * when it is above zero (issue #466). Omitted / `0` keeps the prefix
   * byte-identical to the legacy output.
   */
  skillCatalogDropped?: number;
  systemPersona?: string;
  /**
   * Single-stream decode speed of the local worker daemon (tokens per
   * second), measured once at daemon start and held on the model profile
   * manager. Rendered into the `### fusion` machine facts as "~N tok/s";
   * `null` / absent says nothing. Read only when that block renders.
   */
  fusionTokensPerSecond?: number | null;
  /**
   * Transport the serving link uses for tool calls. Forwarded into
   * `buildStablePrefix`, where `"native_tools"` swaps the text-JSON
   * emission mandate for native function-calling guidance (issue #285).
   * Omitted or `"grammar"` keeps the stable prefix byte-identical to
   * the legacy output.
   */
  toolTransport?: ToolCallTransport;
  /**
   * The turn's tool role (`tool-roles.ts`), forwarded into
   * `buildStablePrefix` (per-role `### tools` block) and used to keep
   * `### loaded-tools` free of tools the prefix already describes in
   * full. Omitted or `"full"` keeps both byte-identical to the
   * pre-role output.
   */
  toolRole?: ToolRole;
  /**
   * Pre-formatted current date (see `formatCurrentDate`) rendered as a
   * `CURRENT DATE:` line in the variable tail just before `### respond`.
   * Lives in the tail, not the stable prefix, so it never affects
   * KV-cache reuse. When omitted the line is not rendered.
   */
  currentDate?: string;
  tokenBudget?: number;
  conversationMaxTokens?: number;
  /** Overrides `agent.conversationMaxPairs` for this build. */
  conversationMaxPairs?: number;
  /**
   * Overrides `agent.conversationLowWater` for this build: the share of
   * a limit the transcript drops to when that limit overflows, so the
   * cut holds for the steps that follow instead of moving every step.
   */
  conversationLowWater?: number;
  /**
   * The model's context window, when something other than the profile
   * probe knows it.
   *
   * `profile.contextWindow` is filled only by the llama-server `/props`
   * probe, so on a cloud model the budget had no window at all and every
   * window-relative decision — the auto cap especially — silently fell
   * back to a fixed number. The provider catalogue does know, and this
   * is how that reaches the budget. Kept separate from `profile` so the
   * UI can still tell a probed window from a catalogued one.
   */
  contextWindow?: number | null;
  /**
   * The local worker leg's request-slot count as the llama-server
   * reported it, `null` (or absent) until observed. The `### fusion`
   * machine facts state it for an external server, whose `--parallel`
   * the config cannot know. See `resolveFusionMachineFacts`.
   */
  liveWorkerSlots?: number | null;
  /**
   * The operator's request behind the running turn, as the runtime
   * recorded it (`pickOriginalRequest`). Rendered as `### request`
   * before `### conversation` only when the packer has dropped the user
   * turn that carried it — see `request-section.ts`.
   */
  originalRequest?: string;
  worldSnapshotMaxTokens?: number;
  completionMaxTokens?: number;
  transientNotice?: string;
  profile?: ModelProfile;
  /**
   * Suppress the llama-server template artifacts around the generation
   * point: the trailing reasoning-open prefill (`<think>` for
   * qwen-think) and the Gemma turn-framing tokens (system-turn opener,
   * `<|think|>` system token, trailing turn close + model-turn opener).
   *
   * Set for prompts served over an OpenAI-compatible *chat* API
   * (`toolTransport: "native_tools"`): there the prompt ships as a chat
   * message, the provider applies its own template server-side, and a
   * literal open tag is at best noise the model echoes back — and at
   * worst corrupted server-side (Ollama Cloud mangles literal
   * `<think>`/`</think>` strings; ollama/ollama#17248, issue #283).
   * The prefill only makes sense on the raw text-completion (grammar)
   * transport, where the local template expects the tag pre-typed.
   */
  suppressReasoningPrefill?: boolean;
  /**
   * `localModels.thinking` as it applies to the hand-built prompt (F49):
   * `off` on a profile with a prompt-side disabled marker (`qwen-think`)
   * ends the prompt with the template's own empty think block instead
   * of the open-tag prefill; `on` / `auto` change nothing, and so does
   * any value on a profile without a marker (Gemma 4's turn framing).
   * Defaults to the config value. Ignored when the prefill is suppressed.
   */
  thinking?: ThinkingSetting;
  profileFacts?: readonly ProfileFact[];
  profileMaxTokens?: number;
  userMessage?: string | null;
  contextualKeywordGate?: boolean;
  /**
   * Hide profile facts with `voteScore <= -threshold`, pinned or not.
   * Defaults to `config.memory.voting.profileFilterThreshold`; `0`
   * disables the filter.
   */
  profileFilterThreshold?: number;
  recallPreviewChars?: number;
  recallMaxTokens?: number;
  memoryIndexMaxTokens?: number;
  /**
   * Memory-v2 phase 5. Safety cap for the `### lessons` pointer
   * section. Defaults to `config.memory.lessons.maxTokens` (300).
   */
  lessonsMaxTokens?: number;
  /**
   * Memory-v2 phase 7b. Safety cap for the `### procedures` pointer
   * section. Defaults to `config.memory.procedures.maxTokens` (400).
   */
  proceduresMaxTokens?: number;
  /** Safety cap for `### loaded-tools` (defaults to `agent.loadedToolsMaxTokens`). */
  loadedToolsMaxTokens?: number;
}

export interface BuiltPromptTruncationFlags {
  loadedSkills: boolean;
  sessionFacts: boolean;
  loadedTools: boolean;
  profile: boolean;
  worldSnapshot: boolean;
  conversation: boolean;
  recalled: boolean;
  memoryIndex: boolean;
}

export interface BuiltPrompt {
  text: string;
  stablePrefix: string;
  tail: string;
  /**
   * The same prompt as structure — stable prefix, the packed turns, and
   * the tail without its `### conversation` section — for a provider
   * that sends history as real chat messages. Built from the same packed
   * conversation as `text`, so the two never disagree.
   */
  messages: PromptMessages;
  tokens: {
    stablePrefix: number;
    loadedSkills: number;
    sessionFacts: number;
    loadedTools: number;
    profile: number;
    worldSnapshot: number;
    conversation: number;
    recalled: number;
    memoryIndex: number;
    taskPolicy: number;
    total: number;
  };
  limits: TokenBudgetLimits;
  truncated: boolean;
  truncation: BuiltPromptTruncationFlags;
  contextWindow: number | null;
  conversationCapEffective: number;
  /**
   * `agent.conversationMaxTokens` was left at `0` — the transcript takes
   * whatever the window leaves rather than sitting under a fixed
   * ceiling. Reported rather than inferred: under auto the configured
   * figure in `limits.conversation` is a *fallback* for an unknown
   * window, not a ceiling, and comparing it against
   * `conversationCapEffective` — which is how the UI decides what is
   * holding the transcript down — would name the wrong knob.
   */
  conversationCapAuto: boolean;
  droppedTurns: number;
  /** Macro-turns the prompt carries. */
  conversationPairs: number;
  /** Macro-turns dropped whole. */
  droppedPairs: number;
  /** The cap in force, i.e. `agent.conversationMaxPairs`. */
  conversationPairsCap: number;
  /** Which limit made the cut, when history was trimmed at all. */
  conversationBoundBy: "pairs" | "tokens" | null;
  /**
   * Where the transcript was cut, for the session to remember so the
   * next build holds the same start (`SessionState.conversationPackStart`).
   * `null` when nothing was dropped.
   */
  conversationPackStart: ConversationPackStart | null;
  /**
   * Token cost of each macro-turn, oldest first.
   *
   * Published so the context panel can answer "what would N tasks cost?"
   * with a prefix sum instead of waiting for the next prompt build —
   * lowering the pair count has to move the gauge while the operator is
   * looking at it, not one turn later. Per-turn costs are already
   * memoised, so this is close to free.
   */
  pairCosts: number[];
  /**
   * Present only when `memory.profile.maxTokens` left facts out of
   * `### profile` (issue #407). Counts, never values.
   */
  profileClip?: ProfileClipStats;
}
