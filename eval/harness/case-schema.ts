/**
 * Strongly-typed contract for a single eval case.
 *
 * A case is a self-contained scenario:
 * - `setup` materialises files / state into the per-case temp workspace.
 * - `prompt` is the user message handed to `atomic-agent run`.
 * - `expectations` are machine-checkable predicates over the outcome:
 *     - text predicates on the assistant reply
 *     - filesystem predicates on the workspace
 *     - tool predicates on the trace (e.g. "agent must have called fs.write")
 *
 * All predicates are AND-combined; a case passes iff every expectation
 * matches. Failures are reported individually so a partially-correct run
 * is still informative.
 */

export type EvalCategory =
  | "os"
  | "skill"
  | "http"
  | "coding"
  | "debug"
  /**
   * GAIA-style document QA: agent receives a question + a fixture
   * document (PDF/XLSX/DOCX) in the workspace and must extract a
   * specific fact via `os.fs.read_document`. Mirrors the GAIA
   * Level 1-2 pattern (file-attached question with a single known
   * answer) without requiring web access or audio/video tools.
   * Authored as self-contained fixtures (NOT real GAIA data) so
   * pass-rates are NOT comparable to published GAIA leaderboards;
   * use as an internal proxy for assistant-style file-fact retrieval.
   */
  | "gaia-style";

/**
 * Capability axes the agent is evaluated against. Each axe-focused case
 * MUST isolate a single axis so a fail directly points at the component
 * to fix (prompt, planner, grammar, tool descriptor, etc.). Scenario
 * cases (the original 35) can be left untagged; their failures stay
 * "mixed-cause" smoke signals.
 *
 * Axis-to-fix mapping (rough):
 *   tool_selection         -> tool descriptors, examples, persona "common tools"
 *   args_shaping           -> grammar, argsSchema, descriptor examples
 *   min_steps              -> persona "bias toward action", task-policy
 *   parallel_batching      -> task-policy broad_exploration, parallel hint
 *   tool_error_recovery    -> step-executor, structured repair
 *   instruction_adherence  -> persona rules, task-policy constraints
 *   self_termination       -> persona, terminal-verbs grammar
 *   grammar_adherence      -> GBNF, repair flow
 *   context_retention      -> conversation packer, latest-result placement
 *   refusal_of_impossible  -> persona honesty rules, error compression
 */
export type CapabilityAxis =
  | "tool_selection"
  | "args_shaping"
  | "min_steps"
  | "parallel_batching"
  | "tool_error_recovery"
  | "instruction_adherence"
  | "self_termination"
  | "grammar_adherence"
  | "context_retention"
  | "refusal_of_impossible";

export interface EvalSetupContext {
  /** Per-case temp working directory; passed to the agent as --cwd. */
  workingDir: string;
  /** Per-case temp state directory; receives ATOMIC_AGENT_STATE_DIR. */
  stateDir: string;
  /** URL of the eval-local mock HTTP server, if started. */
  mockHttpUrl: string | null;
}

export type EvalSetup = (ctx: EvalSetupContext) => Promise<void> | void;

export interface ReplyContainsExpectation {
  kind: "reply_contains";
  pattern: RegExp;
}

export interface FileExistsExpectation {
  kind: "file_exists";
  /** Path relative to workingDir. */
  path: string;
}

export interface FileMatchesExpectation {
  kind: "file_matches";
  path: string;
  pattern: RegExp;
}

export interface ToolInvokedExpectation {
  kind: "tool_invoked";
  /** Name like `os.fs.write` or `skill.view`. Multiple invocations OK. */
  tool: string;
  /** Optional: the matching invocation must have status === "ok". */
  mustSucceed?: boolean;
}

/**
 * Negation of `tool_invoked`. Useful for instruction-adherence cases
 * ("find the bug but DO NOT modify any file"). Fails iff the trace
 * contains AT LEAST one invocation of `tool`. Pure existence check —
 * no `mustSucceed` knob (any call counts, even an error).
 */
export interface ToolNotInvokedExpectation {
  kind: "tool_not_invoked";
  tool: string;
}

/**
 * Bound the LLM step count surfaced by the trace. Diagnostic axis:
 * `min_steps` (was the planner concise?) and `self_termination` (did
 * the agent know when to stop?). Either bound can be omitted.
 */
export interface StepCountExpectation {
  kind: "step_count";
  max?: number;
  min?: number;
}

/**
 * Diagnostic axis `grammar_adherence`: assert structured-repair did not
 * have to fire. Fails iff `metrics.parseRetries > max`.
 */
export interface ParseRetriesMaxExpectation {
  kind: "parse_retries_max";
  max: number;
}

/**
 * Diagnostic axis `parallel_batching`: assert the planner saw the
 * independent-action signal and packed at least `min` calls into a
 * single inference's array. Reads `metrics.maxBatchSize`.
 */
export interface BatchSizeMinExpectation {
  kind: "batch_size_min";
  min: number;
}

/**
 * LLM-as-judge expectation. The judge receives the original prompt, the
 * agent's reply, and the rubric; it returns an integer score 1..5. The
 * expectation passes iff `verdict.score >= threshold` (default 4).
 *
 * If the eval run has no judge client configured, the expectation fails
 * with a clear "judge unavailable" message rather than silently passing.
 */
export interface JudgeExpectation {
  kind: "judge";
  /** Free-form criteria the judge applies to the reply. */
  rubric: string;
  /** Default 4 (i.e. require "correct content with minor issues" or better). */
  threshold?: number;
}

export type EvalExpectation =
  | ReplyContainsExpectation
  | FileExistsExpectation
  | FileMatchesExpectation
  | ToolInvokedExpectation
  | ToolNotInvokedExpectation
  | StepCountExpectation
  | ParseRetriesMaxExpectation
  | BatchSizeMinExpectation
  | JudgeExpectation;

export interface EvalCase {
  /** Stable id for reporting (kebab-case, unique). */
  id: string;
  /** Short human-readable label. */
  name: string;
  category: EvalCategory;
  /**
   * Optional capability axis this case isolates. Axe-focused cases set
   * exactly one axis; scenario cases (the original 35) leave it unset.
   * Read by the per-axis summarizer; never affects pass/fail logic.
   */
  capabilityAxis?: CapabilityAxis;
  /** User message fed to the agent (one turn). */
  prompt: string;
  /** Override config.agent.maxSteps for this case. */
  maxSteps?: number;
  setup?: EvalSetup;
  expectations: EvalExpectation[];
  /**
   * Tag a case as `requires:` to guard against missing prerequisites. The
   * runner can choose to skip when the tag is unmet (e.g. mock server,
   * installed skill).
   */
  requires?: ReadonlyArray<"mock-http" | "eval-skill">;
}
