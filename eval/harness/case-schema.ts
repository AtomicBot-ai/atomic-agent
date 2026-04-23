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

export type EvalCategory = "os" | "skill" | "http";

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
  | JudgeExpectation;

export interface EvalCase {
  /** Stable id for reporting (kebab-case, unique). */
  id: string;
  /** Short human-readable label. */
  name: string;
  category: EvalCategory;
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
