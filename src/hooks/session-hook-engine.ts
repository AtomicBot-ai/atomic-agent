import { loadAllHooks } from "./hook-config.js";
import type { HookLogger } from "./hook-engine.js";
import { matcherMatches } from "./hook-matcher.js";
import { runHookCommand, type HookRunResult, type RunHookOptions } from "./hook-runner.js";
import type { HookCommand, LoadedHooks, SessionHookEvent } from "./hook-types.js";
import { combineSessionVerdicts, interpretSessionHookRun, type SessionHookVerdict } from "./session-hook-output.js";

export interface SessionHookEngineOptions {
  stateDir: string;
  logger?: HookLogger;
  /** Test seams. */
  load?: () => LoadedHooks;
  run?: (hook: HookCommand, input: unknown, options: RunHookOptions) => Promise<HookRunResult>;
}

/** Where a turn is about to start. */
export interface TurnStartFacts {
  sessionId: string;
  cwd: string;
  prompt: string;
  /** The session has no earlier turn: SessionStart says `startup`, else `resume`. */
  isNewSession: boolean;
  signal?: AbortSignal;
}

export type TurnStartOutcome =
  | { kind: "blocked"; reason: string }
  | {
      kind: "proceed";
      /** What SessionStart printed for this session; returned on every turn, not only the first. */
      sessionContext?: string;
      /** What UserPromptSubmit printed for this turn only. */
      context?: string;
    };

/** How a turn just ended, for the Stop hooks. */
export interface TurnStopFacts {
  sessionId: string;
  cwd: string;
  /** The reply the agent just gave, when there is one. */
  lastReply?: string;
  /** True when this turn is already a Stop-hook continuation (Claude's `stop_hook_active`). */
  stopHookActive: boolean;
  signal?: AbortSignal;
}

export interface CompactFacts {
  sessionId: string;
  cwd: string;
  trigger: "manual" | "auto";
  instructions?: string;
  signal?: AbortSignal;
}

const NEVER = new AbortController().signal;

/**
 * Runs the session-level hooks: SessionStart and UserPromptSubmit before a
 * turn, Stop after it, PreCompact before a compaction. Same files, runner
 * and timeouts as the tool hooks; a failing hook is logged and never
 * blocks. Only UserPromptSubmit (refuse the prompt) and Stop (keep
 * working) can change what happens; neither touches approval.
 */
export class SessionHookEngine {
  private readonly logged = new Set<string>();
  /**
   * Sessions this process already fired SessionStart for, with what it
   * printed. Kept for the session's life in this process, as Claude Code
   * keeps SessionStart context for the whole session; a new process fires
   * SessionStart again (`resume`) and fills it anew.
   */
  private readonly started = new Map<string, string | undefined>();

  constructor(private readonly options: SessionHookEngineOptions) {}

  private hooks(): LoadedHooks {
    const loaded = this.options.load ? this.options.load() : loadAllHooks(this.options.stateDir);
    for (const line of loaded.diagnostics) {
      if (this.logged.has(line)) continue;
      this.logged.add(line);
      this.options.logger?.warn("hooks: entry skipped", { diagnostic: line });
    }
    return loaded;
  }

  /**
   * The hook commands of `event`. SessionStart's matcher is tested against
   * its source (`startup` / `resume`), PreCompact's against its trigger
   * (`manual` / `auto`); UserPromptSubmit and Stop ignore the matcher, as
   * in Claude Code.
   */
  matching(event: SessionHookEvent, target?: string): HookCommand[] {
    const groups = this.hooks().config[event] ?? [];
    const out: HookCommand[] = [];
    for (const group of groups) {
      if (target === undefined || matcherMatches(group.matcher, target)) out.push(...group.hooks);
    }
    return out;
  }

  /** Run every hook of `event` in parallel and combine what they said. */
  async runEvent(
    event: SessionHookEvent,
    input: Record<string, unknown>,
    where: { cwd: string; signal?: AbortSignal; target?: string },
  ): Promise<SessionHookVerdict & { ran: number }> {
    const hooks = this.matching(event, where.target);
    if (hooks.length === 0) return { ran: 0 };
    const run = this.options.run ?? runHookCommand;
    const signal = where.signal ?? NEVER;
    const verdicts = await Promise.all(
      hooks.map(async (hook) => interpretSessionHookRun(event, hook, await run(hook, input, { cwd: where.cwd, signal }))),
    );
    const combined = combineSessionVerdicts(verdicts);
    if (combined.error) this.options.logger?.warn("hooks: hook failed", { event, error: combined.error });
    return { ...combined, ran: hooks.length };
  }

  /**
   * SessionStart (first turn this process runs for the session), then
   * UserPromptSubmit. A UserPromptSubmit block refuses the prompt. The
   * SessionStart text comes back on every turn of the session; the
   * UserPromptSubmit text belongs to this turn only.
   */
  async beforeTurn(facts: TurnStartFacts): Promise<TurnStartOutcome> {
    const where = { cwd: facts.cwd, ...(facts.signal ? { signal: facts.signal } : {}) };
    if (!this.started.has(facts.sessionId)) {
      this.started.set(facts.sessionId, undefined);
      const source = facts.isNewSession ? "startup" : "resume";
      const start = await this.runEvent("SessionStart", { ...base("SessionStart", facts), source }, { ...where, target: source });
      this.started.set(facts.sessionId, start.context);
    }
    const sessionContext = this.started.get(facts.sessionId);
    const submit = await this.runEvent("UserPromptSubmit", { ...base("UserPromptSubmit", facts), prompt: facts.prompt }, where);
    if (submit.block !== undefined) return { kind: "blocked", reason: submit.block };
    return {
      kind: "proceed",
      ...(sessionContext !== undefined ? { sessionContext } : {}),
      ...(submit.context ? { context: submit.context } : {}),
    };
  }

  /** Stop: the reason to keep working, or undefined to let the turn end. */
  async afterTurn(facts: TurnStopFacts): Promise<string | undefined> {
    const verdict = await this.runEvent(
      "Stop",
      { ...base("Stop", facts), stop_hook_active: facts.stopHookActive, last_assistant_message: facts.lastReply ?? null },
      { cwd: facts.cwd, ...(facts.signal ? { signal: facts.signal } : {}) },
    );
    return verdict.block;
  }

  /** PreCompact: informs only; it never stops the compaction. */
  async beforeCompact(facts: CompactFacts): Promise<void> {
    await this.runEvent(
      "PreCompact",
      { ...base("PreCompact", facts), trigger: facts.trigger, custom_instructions: facts.instructions ?? "" },
      { cwd: facts.cwd, target: facts.trigger, ...(facts.signal ? { signal: facts.signal } : {}) },
    );
  }
}

/** The fields every Claude Code hook reads on stdin. */
function base(event: SessionHookEvent, facts: { sessionId: string; cwd: string }): Record<string, unknown> {
  return {
    session_id: facts.sessionId,
    transcript_path: null,
    cwd: facts.cwd,
    permission_mode: "default",
    hook_event_name: event,
  };
}

/** The text a Stop-hook continuation turn carries in place of a user message. */
export function stopHookMessage(reason: string): string {
  return `[Stop hook] A hook the user set up asked you to keep working before you stop:\n${reason}`;
}

/** A UserPromptSubmit hook refused the prompt; the turn never started and nothing was saved. */
export class HookBlockedPromptError extends Error {
  override readonly name = "HookBlockedPromptError";
  constructor(readonly reason: string) {
    super(`A UserPromptSubmit hook blocked this message: ${reason}`);
  }
}

/** How many times Stop hooks may send the agent back to work within one turn. */
export const MAX_STOP_HOOK_CONTINUATIONS = 3;
