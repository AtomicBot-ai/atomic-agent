import { statSync } from "node:fs";
import { dirname } from "node:path";

import {
  ApprovalDeniedError,
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolContext } from "../tool-registry.js";
import { sessionReadRefusal, sessionReadRoots } from "./read-scope.js";

/**
 * A read outside the scope is a QUESTION, not a refusal.
 *
 * The scope (`read-scope.ts`) says where a session may read unasked;
 * this module is what happens at the edge of it. A read-class call or a
 * shell command naming a path outside every root goes through the
 * ladder as `fs_read_outside` — the same prompt every other gated
 * action gets, on whichever surface owns the session — and the answer
 * is remembered: a `y` widens the session's roots to the directory it
 * named (`ReadScopeGrants` on the gate), so one question covers the
 * reads that follow under it; `[s]` grants the whole category, which is
 * "read anywhere this session". A `n` is the refusal the model would
 * have got before: one line naming the path, the working directory and
 * the way out. Level 5 / `--no-approval` never asks, like every other
 * category pinned there. Fusion workers never reach this module — their
 * check refuses first, because nobody is at the other end of a worker's
 * prompt.
 *
 * Questions are asked one at a time per session. Read tools run in
 * parallel inside a batch, and two prompts raised at once would leave
 * one of them stranded behind the other on a surface that shows a
 * single pending request. So the check-and-ask runs under a per-session
 * queue: the second read waits for the first's answer and re-checks
 * against the widened roots — usually to find it no longer needs to ask.
 */

/**
 * The directory an approval widens the session's reads to: the path
 * itself when it is a directory, otherwise its parent. A file's parent
 * rather than the file, because a model asked to summarise one report
 * in a folder will reach for the next one, and the operator who said
 * yes to the folder's first file has seen where the model is reading.
 */
export function widenedReadRoot(path: string): string {
  try {
    if (statSync(path).isDirectory()) return path;
  } catch {
    // Absent or unreadable: the parent is the honest unit either way.
  }
  return dirname(path);
}

export interface ReadOutsidePrompt {
  reason: string;
  preview?: string;
}

const consequence = (root: string): string =>
  `approving allows reads under ${root} for the rest of this session`;

/** The prompt for a read-class call: what is read, from where, and what a `y` means. */
export function readOutsidePrompt(
  path: string,
  workingDir: string,
  root: string,
): ReadOutsidePrompt {
  return {
    reason: `read ${path} — outside the working directory (${workingDir}); ${consequence(root)}`,
  };
}

/** The prompt for a shell command naming a path outside the scope. */
export function shellReadOutsidePrompt(
  commandLine: string,
  path: string,
  workingDir: string,
  root: string,
): ReadOutsidePrompt {
  return {
    reason: `run \`${commandLine}\` — reads outside the working directory (${workingDir}): ${path}; ${consequence(root)}`,
    preview: commandLine,
  };
}

/** One task at a time per session, in arrival order; a failure does not block the next. */
class SessionQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return result;
  }
}

type ScopedContext = Pick<
  ToolContext,
  "sessionId" | "workingDir" | "readRoots" | "signal"
>;

/**
 * The asking half of the read scope, one per registry install. Holds
 * the ladder wiring (`DangerousToolOptions`) and the per-session queue;
 * the roots it checks against are the session's own plus what the gate
 * remembers for it.
 */
export class ReadOutsideApprover {
  private readonly queue = new SessionQueue();

  constructor(private readonly options: DangerousToolOptions) {}

  /** Working directory, user-named paths, and the directories approved so far. */
  roots(ctx: Pick<ScopedContext, "sessionId" | "workingDir" | "readRoots">): string[] {
    return [
      ...sessionReadRoots(ctx),
      ...this.options.approvals.readScopeGrants.rootsFor(ctx.sessionId),
    ];
  }

  /**
   * Let `tool`'s call through, or not. `outsideOf(roots)` names the
   * first path the call reaches outside `roots` (or `null`); when there
   * is one, the operator is asked with `promptFor(path, root)`. Resolves
   * `null` when the call may run (nothing outside, or approved — and
   * then `root` is remembered), or the refusal when it was denied.
   */
  admit(
    tool: string,
    ctx: ScopedContext,
    outsideOf: (roots: readonly string[]) => string | null,
    promptFor: (path: string, root: string) => ReadOutsidePrompt,
  ): Promise<CompressedToolResult | null> {
    return this.queue.run(ctx.sessionId, async () => {
      const roots = this.roots(ctx);
      const path = outsideOf(roots);
      if (path === null) return null;
      const root = widenedReadRoot(path);
      const prompt = promptFor(path, root);
      try {
        await requireApproval(
          this.options,
          {
            sessionId: ctx.sessionId,
            tool,
            category: "fs_read_outside",
            reason: prompt.reason,
            ...(prompt.preview !== undefined ? { preview: prompt.preview } : {}),
            affectedResources: [root],
          },
          ctx.signal,
        );
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return sessionReadRefusal(tool, path, ctx, roots);
        }
        throw err;
      }
      this.options.approvals.readScopeGrants.widen(ctx.sessionId, root);
      return null;
    });
  }
}
