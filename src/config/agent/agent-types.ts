import type { ApprovalLevel } from "../../approval/approval-level.js";
import type { AgentTaskConfig, ProviderWaitConfig } from "../agent-execution-config.js";

/**
 * Where a session's tools may READ (config v67).
 *
 *  - `working-dir`: the working directory plus every absolute or
 *    `~`-prefixed path the user named in this session's own messages
 *    read unasked; anything else asks through the approval ladder
 *    (`fs_read_outside`, silent at level 5) and a yes widens the
 *    session's roots (see `src/tools/read-scope/`). The default.
 *  - `unrestricted`: the pre-v67 behaviour — reads anywhere on disk,
 *    never asked about.
 *
 * Fusion workers are confined regardless (and more narrowly).
 */
export type ReadScope = "working-dir" | "unrestricted";

export interface RuntimeAgentConfig {
  /**
   * Compact target for the upper prompt. Its only remaining effect on
   * a built prompt is the `### session-facts` + `### loaded-skills`
   * share, and `sessionSectionsMaxTokens` now overrides that directly;
   * the stable prefix is sized by what it contains, not by this
   * number.
   */
  tokenBudget: number;
  /**
   * Steps in one *leg* of a task — a checkpoint interval, not the end
   * of the work.
   *
   * It used to be the end of the work, and that was the wrong unit: a
   * step is one model turn plus its tool calls, while what the user
   * asked for ("register on these ten sites") is a task made of
   * hundreds of them. Ending the task on a step count meant a long job
   * stopped mid-way with `(stopped: max_steps reached without a
   * reply)` and no way to continue. Now the loop reaches this number,
   * checks that the leg actually made progress, says so, and carries
   * on — up to {@link UserConfigFile.agent.task}.
   */
  maxSteps: number;
  providerWait: ProviderWaitConfig;
  task: AgentTaskConfig;
  toolTimeoutMs: number;
  /** Where reads may go: the working directory and user-named paths, or anywhere. */
  readScope: ReadScope;
  /**
   * Boot value for the five-step approval ladder (1 = ask for
   * everything … 5 = approve everything). The live value is owned by
   * the ApprovalGate; see `runtime.setApprovalLevel`.
   */
  approvalLevel: ApprovalLevel;
  stablePrefixHashSalt: string;
  /**
   * Safety-net ceiling for the `### conversation` section of the prompt.
   * Typical sessions stay well under this cap — it exists to prevent
   * pathological growth, not to be a regular truncation mechanism.
   *
   * **`0` means auto:** the transcript takes whatever the model's
   * window leaves after the scaffold, the memory sections and the
   * reply reservation, with no fixed ceiling above it. Same sentinel
   * and same reasoning as `localModels.managed.contextSize` — the
   * useful value is a function of hardware this file cannot see.
   *
   * **The shipped default IS `0`** — this paragraph used to claim it
   * stayed at 32k, which stopped being true when auto landed, and the
   * number was the one thing an operator would act on.
   *
   * Auto is not unbounded spend: it is what the window leaves, and a
   * model whose window nobody has published falls back to
   * `CONVERSATION_CAP_AUTO_FALLBACK` (64k). An operator on a metered
   * cloud model who wants a tighter ceiling than the window sets a
   * number here, and the context panel says so when that ceiling —
   * rather than the window — is what holds the transcript down.
   */
  conversationMaxTokens: number;
  /**
   * Macro-turns of history the prompt carries — one per task you sent,
   * each carrying everything the agent did answering it. The knob an
   * operator actually reaches for; `conversationMaxTokens` remains the
   * ceiling underneath it.
   */
  conversationMaxPairs: number;
  /**
   * Ask the model to name each session from its first prompt.
   *
   * One extra short completion per session, once, after the first
   * answered turn. It is a real call on a metered provider, which is
   * the whole reason this is a switch rather than a fact: the lists
   * are perfectly usable showing the prompt itself, which is what
   * they showed before.
   */
  nameSessions: boolean;
  /**
   * Share of a limit the transcript drops to when that limit
   * overflows, `(0, 1]`. The cut then holds until the next overflow,
   * so between cuts the prompt only grows at its end and a local
   * model's KV cache is reused instead of re-read. `1` cuts just
   * enough every step (the old behaviour).
   */
  conversationLowWater: number;
  /**
   * Ceiling for `### session-facts` + `### loaded-skills` combined —
   * the one prompt limit `tokenBudget` still moves. `0` keeps the
   * historical `tokenBudget * 0.15` share
   * (`SESSION_SECTIONS_CAP_AUTO`).
   */
  sessionSectionsMaxTokens: number;
  /**
   * Safety-net ceiling for the `### world` section. ARIA snapshots are
   * already compressed at the browser layer; this cap guards against
   * edge cases where compression misses (huge SVG trees, etc.).
   */
  worldSnapshotMaxTokens: number;
  /**
   * Max `### loaded-tools` rare-schema entries kept per session (LRU
   * by `loadedAt`). Env-only: `ATOMIC_AGENT_LOADED_TOOLS_CAP`.
   */
  loadedToolsCap: number;
  /**
   * Safety cap for the `### loaded-tools` section in the variable tail.
   * Env-only: `ATOMIC_AGENT_LOADED_TOOLS_MAX_TOKENS`.
   */
  loadedToolsMaxTokens: number;
  /**
   * On rare-tool execution error, auto-inject the full schema into
   * `### loaded-tools` for the next step. Env-only:
   * `ATOMIC_AGENT_AUTO_EXPAND_RARE_ON_ERROR`.
   */
  autoExpandRareOnError: boolean;
  /**
   * Maximum number of tool calls the model may emit in a single
   * inference step (a "batch"). The grammar caps the array at 16
   * structurally; this knob is the runtime soft cap and also drives
   * the prompt instructions paragraph. Env-only:
   * `ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS`. Hard upper bound: 16.
   */
  maxParallelToolCalls: number;
  /**
   * Soft cap on the combined character length of all tool-result
   * summaries appended in a single batched step. When exceeded the
   * oldest within-batch results get an extra truncation pass before
   * being added to the conversation transcript. Env-only:
   * `ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP`.
   */
  batchToolResultCharCap: number;
  /**
   * What survives **ingestion** of a non-`gog` `os.shell.run` result.
   * The compressor runs inside the tool and its summary is what gets
   * stored as the `tool_result` turn, so whatever these drop is gone —
   * not paged, not deferred. Before they existed the shell tool took
   * the compressor's bare defaults (400 chars / 12 lines) while every
   * read-oriented tool passed 8–64 KB. `gog` keeps its own far larger
   * options and ignores both. Env-only:
   * `ATOMIC_AGENT_SHELL_TOOL_RESULT_CHAR_CAP`,
   * `ATOMIC_AGENT_SHELL_TOOL_RESULT_TAIL_LINES`.
   */
  shellToolResultCharCap: number;
  shellToolResultTailLines: number;
  /**
   * No-progress loop detection (OpenClaw-style `ToolLoopTracker`).
   * `loopWarningThreshold` — args-only repeat count that injects a
   * `### notice` (env `ATOMIC_AGENT_LOOP_WARNING_THRESHOLD`).
   * `loopCriticalThreshold` — identical args+result streak that vetoes
   * the call before dispatch (env `ATOMIC_AGENT_LOOP_CRITICAL_THRESHOLD`).
   * `loopBreakerVetoStreak` — consecutive vetoes of one signature that
   * force a graceful reply (env `ATOMIC_AGENT_LOOP_BREAKER_VETO_STREAK`).
   * `loopHistorySize` — sliding window size for the tracker's history
   * ring (env `ATOMIC_AGENT_LOOP_HISTORY_SIZE`).
   * `loopWanderingThreshold` — distinct-args spread on a wandering-prone
   * tool (search/web/http/browser), counted since the turn last made
   * progress outside that tool's family, that injects an actionable
   * redirect notice (env `ATOMIC_AGENT_LOOP_WANDERING_THRESHOLD`).
   * `loopWanderingEscalation` — the same run spread at which the loop
   * escalates to a forced graceful reply (env
   * `ATOMIC_AGENT_LOOP_WANDERING_ESCALATION`). The window spread has its
   * own rungs, derived from `loopHistorySize` — see
   * `WANDERING_CEILING_SHARE`.
   * All env-only.
   */
  loopWarningThreshold: number;
  loopCriticalThreshold: number;
  loopBreakerVetoStreak: number;
  loopHistorySize: number;
  loopWanderingThreshold: number;
  loopWanderingEscalation: number;
}

export interface UserAgentConfig {
  tokenBudget: number;
  /** Steps in one leg of a task — a checkpoint, not the end of it. */
  maxSteps: number;
  /** Wait out a provider outage instead of failing the turn. */
  providerWait: ProviderWaitConfig;
  /** Ceilings that actually end a task. See the runtime type above. */
  task: AgentTaskConfig;
  toolTimeoutMs: number;
  /**
   * Where a session's reads may go (config v67). `working-dir` (the
   * default) confines filesystem reads and shell path arguments to the
   * working directory and the paths the user named in the conversation;
   * `unrestricted` is the pre-v67 behaviour.
   */
  readScope: ReadScope;
  /**
   * Five-step approval ladder (config v37). Replaces the binary
   * `approvalRequired`; the legacy key is still read once for
   * migration (see `resolveApprovalLevel`) and never written back.
   */
  approvalLevel: ApprovalLevel;
  conversationMaxTokens: number;
  /**
   * How many macro-turns of history the prompt carries — one "pair"
   * being a task you sent plus everything the agent did answering it.
   *
   * This is the knob to reach for. Tokens are the wrong unit to steer
   * with: nobody thinks in tokens, they think in how many of their
   * last tasks the agent should still know about.
   * {@link UserConfigFile.agent.conversationMaxTokens} stays underneath
   * as the ceiling, because a pair has no bounded size — one task can
   * run `maxSteps` tool calls and a fresh `os.http.request` body is
   * rendered uncapped — so N pairs can exceed any window. Whichever
   * limit bites first wins.
   */
  conversationMaxPairs: number;
  /** Ask the model to name each session (config v72). */
  nameSessions: boolean;
  /**
   * Share of a limit the transcript keeps after a cut, `(0, 1]`.
   * History is dropped in chunks — down to this share of the token
   * budget or of `conversationMaxPairs`, whichever overflowed — and
   * the cut then holds until the next overflow, so the prompt is
   * append-only in between and a local model reuses its KV cache. A
   * model with no partial prefix reuse (sliding-window attention) is
   * held to at most `0.5`. `1` restores cutting just enough per step.
   */
  conversationLowWater: number;
  /**
   * Ceiling on `### session-facts` + `### loaded-skills` combined
   * (config v74). One cap over two sections because one
   * `truncateToTokens` call trims the two as a single blob, facts
   * first, so the skill bodies at its tail are what a cut takes.
   *
   * `0` is `SESSION_SECTIONS_CAP_AUTO`: keep the historical
   * `tokenBudget * 0.15`. Raising it costs no KV cache — both sections
   * sit in the variable tail — but it does eat into the room
   * `computeEffectiveConversationCap` leaves the transcript, since
   * `sessionTokens` is subtracted from the window there.
   *
   * Any other value is enforced verbatim: no floor at the bottom (a
   * value too small for one token empties both sections) and no clamp
   * against the model's context window at the top (past
   * `CONVERSATION_CAP_FLOOR` the transcript has nothing left to give
   * and the prompt overruns the window). Both are spelled out on
   * `SESSION_SECTIONS_CAP_AUTO` with the reasons.
   *
   * There is deliberately no sibling key for the stable prefix. Its
   * `tokenBudget * 0.35` figure is computed and then read by nothing:
   * the prefix cannot be trimmed without cutting `### tools` or
   * `### instructions` out from under the grammar. Size the prefix
   * with `skills.catalogTokenBudget` (its one elastic section) and the
   * `tool.view` tier split instead.
   */
  sessionSectionsMaxTokens: number;
  worldSnapshotMaxTokens: number;
}
