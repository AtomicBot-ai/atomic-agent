import { basename, relative } from "node:path";
import { FileChangedWatchers, type DirWatcherFactory, type FileChangeEvent, type WatchClock } from "./file-changed-watcher.js";
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
  watchFactory?: DirWatcherFactory;
  watchClock?: WatchClock;
}

/**
 * Why a session ended, ours; `reason` on stdin is Claude Code's word for
 * it (`clear`, `prompt_input_exit`, `other`), `atomic_reason` is this.
 */
export type SessionEndCause = "deleted" | "finished" | "shutdown";

const CLAUDE_END_REASON: Record<SessionEndCause, string> = {
  deleted: "clear",
  finished: "other",
  shutdown: "prompt_input_exit",
};

/** A subagent or Fusion worker turn that just ended, for SubagentStop. */
export interface SubagentStopFacts extends TurnStopFacts {
  /** The worker's own session id (Claude's `agent_id`); `sessionId` is the parent's. */
  agentId: string;
  agentType: "subagent" | "fusion-worker";
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
 * turn, Stop after it, SubagentStop after a worker's turn, PreCompact
 * before a compaction, SessionEnd when a session ends, FileChanged when a
 * file in a session's folder changes. Same files, runner and timeouts as
 * the tool hooks; a failing hook is logged and never blocks. Only
 * UserPromptSubmit (refuse the prompt) and Stop / SubagentStop (keep
 * working) can change what happens; none touches approval.
 */
export class SessionHookEngine {
  private readonly logged = new Set<string>();
  /**
   * Sessions this process already fired SessionStart for, with what it
   * printed and their folder. Kept for the session's life in this process,
   * as Claude Code keeps SessionStart context for the whole session; a new
   * process fires SessionStart again (`resume`) and fills it anew.
   * SessionEnd fires once for each entry and removes it.
   */
  private readonly started = new Map<string, { context?: string; cwd: string }>();
  /** Folders watched for FileChanged, created on first use. */
  private files: FileChangedWatchers | null = null;

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
   * (`manual` / `auto`), and so on for the events that name a target;
   * UserPromptSubmit and Stop ignore the matcher, as in Claude Code. With
   * several targets a group matches when any of them does.
   */
  matching(event: SessionHookEvent, target?: string | readonly string[]): HookCommand[] {
    const groups = this.hooks().config[event] ?? [];
    const targets = target === undefined ? undefined : typeof target === "string" ? [target] : target;
    const out: HookCommand[] = [];
    for (const group of groups) {
      if (targets === undefined || targets.some((t) => matcherMatches(group.matcher, t))) out.push(...group.hooks);
    }
    return out;
  }

  /** Run every hook of `event` in parallel and combine what they said. */
  async runEvent(
    event: SessionHookEvent,
    input: Record<string, unknown>,
    where: { cwd: string; signal?: AbortSignal; target?: string | readonly string[] },
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
      this.started.set(facts.sessionId, { cwd: facts.cwd });
      const source = facts.isNewSession ? "startup" : "resume";
      const start = await this.runEvent("SessionStart", { ...sessionHookBase("SessionStart", facts), source }, { ...where, target: source });
      // Still started: a SessionEnd during the hook already removed it.
      const entry = this.started.get(facts.sessionId);
      if (entry && start.context !== undefined) entry.context = start.context;
    }
    // A FileChanged hook in config: watch this session's folder (checked
    // every turn, so a hook added mid-session starts watching on the next).
    if (this.started.has(facts.sessionId) && this.matching("FileChanged").length > 0) {
      this.watchers().watch(facts.cwd, facts.sessionId);
    }
    const sessionContext = this.started.get(facts.sessionId)?.context;
    const submit = await this.runEvent("UserPromptSubmit", { ...sessionHookBase("UserPromptSubmit", facts), prompt: facts.prompt }, where);
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
      { ...sessionHookBase("Stop", facts), stop_hook_active: facts.stopHookActive, last_assistant_message: facts.lastReply ?? null },
      { cwd: facts.cwd, ...(facts.signal ? { signal: facts.signal } : {}) },
    );
    return verdict.block;
  }

  /**
   * SubagentStop after a subagent or Fusion worker turn: the reason to keep
   * that worker going, or undefined to let it hand its answer up.
   * `session_id` is the parent's, as in Claude Code; the matcher is tested
   * against `agent_type`.
   */
  async afterSubagentTurn(facts: SubagentStopFacts): Promise<string | undefined> {
    const verdict = await this.runEvent(
      "SubagentStop",
      {
        ...sessionHookBase("SubagentStop", facts),
        stop_hook_active: facts.stopHookActive,
        agent_id: facts.agentId,
        agent_type: facts.agentType,
        agent_transcript_path: null,
        last_assistant_message: facts.lastReply ?? null,
      },
      { cwd: facts.cwd, target: facts.agentType, ...(facts.signal ? { signal: facts.signal } : {}) },
    );
    return verdict.block;
  }

  /**
   * SessionEnd, once per session this process started, and only those:
   * a session that never ran a turn here has nothing to end. Informs only.
   * Its folder stops being watched for FileChanged.
   */
  async endSession(sessionId: string, cause: SessionEndCause): Promise<void> {
    const entry = this.started.get(sessionId);
    if (!entry) return;
    this.started.delete(sessionId);
    this.files?.unwatch(sessionId);
    await this.runEvent(
      "SessionEnd",
      { ...sessionHookBase("SessionEnd", { sessionId, cwd: entry.cwd }), reason: CLAUDE_END_REASON[cause], atomic_reason: cause },
      { cwd: entry.cwd, target: [CLAUDE_END_REASON[cause], cause] },
    );
  }

  /** SessionEnd for every session still open in this process (shutdown); closes the watchers. */
  async endAll(cause: SessionEndCause = "shutdown"): Promise<void> {
    await Promise.all([...this.started.keys()].map((id) => this.endSession(id, cause)));
    await this.files?.closeAll();
  }

  /** FileChanged: informs only. The matcher is tested against the file name and its path in the folder. */
  async fileChanged(dir: string, path: string, event: FileChangeEvent): Promise<void> {
    const sessionId = this.files?.sessionFor(dir);
    if (sessionId === undefined) return;
    const name = basename(path);
    const rel = relative(dir, path).split("\\").join("/");
    await this.runEvent(
      "FileChanged",
      { ...sessionHookBase("FileChanged", { sessionId, cwd: dir }), file_path: path, event, atomic_relative_path: rel },
      { cwd: dir, target: [name, rel] },
    );
  }

  private watchers(): FileChangedWatchers {
    this.files ??= new FileChangedWatchers({
      onChange: (dir, path, event) => {
        void this.fileChanged(dir, path, event).catch(() => undefined);
      },
      onError: (dir, err) => this.options.logger?.warn("hooks: FileChanged watcher failed", { dir, error: err.message }),
      ...(this.options.watchFactory ? { factory: this.options.watchFactory } : {}),
      ...(this.options.watchClock ? { clock: this.options.watchClock } : {}),
    });
    return this.files;
  }

  /** PreCompact: informs only; it never stops the compaction. */
  async beforeCompact(facts: CompactFacts): Promise<void> {
    await this.runEvent(
      "PreCompact",
      { ...sessionHookBase("PreCompact", facts), trigger: facts.trigger, custom_instructions: facts.instructions ?? "" },
      { cwd: facts.cwd, target: facts.trigger, ...(facts.signal ? { signal: facts.signal } : {}) },
    );
  }
}

/** The fields every Claude Code hook reads on stdin. */
export function sessionHookBase(event: SessionHookEvent, facts: { sessionId: string; cwd: string }): Record<string, unknown> {
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
