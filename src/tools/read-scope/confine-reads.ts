import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ReadScope } from "../../config/index.js";
import { isFusionWorkerSessionId } from "../../session/fusion-worker-session.js";
import type { ToolDefinition, ToolRegistry } from "../tool-registry.js";
import {
  checkWorkerRead,
  findSessionReadOutside,
  workerReadRefusal,
} from "./read-scope.js";
import {
  ReadOutsideApprover,
  readOutsidePrompt,
  shellReadOutsidePrompt,
} from "./read-scope-approval.js";
import {
  findShellPathOutsideScope,
  shellCommandLine,
  type ShellScopeEnv,
} from "./read-scope-shell.js";
import { READ_TOOL_TARGETS, SHELL_TOOL } from "./read-scope-targets.js";

export interface ConfineReadsOptions {
  /** The directories a fusion worker's fan-out may write in. */
  grantedDirs: (sessionId: string) => readonly string[];
  /**
   * The live `agent.readScope`. Read on every call, so a config change
   * takes effect without a restart. Omitted: only fusion workers are
   * confined and the shell is not wrapped — the pre-v67 install
   * (`confineWorkerReads`).
   */
  readScope?: () => ReadScope;
  /**
   * The ladder a read outside the scope asks through (`fs_read_outside`,
   * `read-scope-approval.ts`). Required with `readScope`: the session
   * scope is a question, and a question needs a gate — an install that
   * forgot the gate would silently be a refusal, which is exactly the
   * half-wiring the throw below exists to catch.
   */
  approvals?: DangerousToolOptions;
  /** The shell check's notion of home and platform; a test seam. */
  shellEnv?: ShellScopeEnv;
}

/** Definitions this module produced, so a second install does not wrap twice. */
const CONFINED = new WeakSet<ToolDefinition>();

/**
 * Wrap every registered read-class tool (and, under a session scope, the
 * shell) so a call is checked before it runs. Call once, after the
 * native tools are registered. Returns the names it confined.
 *
 * Wrapping at the registry rather than inside each tool keeps the rule
 * in one place, and `registry.invoke` is the single path every call —
 * native, batched, or recovered from text — takes. A worker session
 * gets the worker check first (always on, a refusal); then, when the
 * scope is `working-dir`, every other session's call outside the roots
 * is asked about, and runs or is refused by the answer.
 */
export function confineReads(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: ConfineReadsOptions,
): string[] {
  if (options.readScope !== undefined && options.approvals === undefined) {
    throw new Error(
      "confineReads: a session read scope asks through the approval ladder; pass `approvals` with `readScope`",
    );
  }
  const asker =
    options.approvals === undefined
      ? null
      : new ReadOutsideApprover(options.approvals);
  const confined: string[] = [];
  const scoped = () => options.readScope?.() === "working-dir";
  const install = (name: string, run: ToolDefinition["run"]): void => {
    const inner = registry.get(name);
    confined.push(name);
    if (CONFINED.has(inner)) return;
    const wrapped: ToolDefinition = { ...inner, run };
    CONFINED.add(wrapped);
    registry.register(wrapped);
  };

  for (const name of READ_TOOL_TARGETS.keys()) {
    if (!registry.has(name)) continue;
    const inner = registry.get(name);
    install(name, async (args, ctx) => {
      const worker = checkWorkerRead(
        name,
        args,
        ctx,
        options.grantedDirs(ctx.sessionId),
      );
      if (worker !== null) return worker;
      if (asker === null || !scoped()) return inner.run(args, ctx);
      const refusal = await asker.admit(
        name,
        ctx,
        (roots) => findSessionReadOutside(name, args, ctx, roots),
        (path, root) => readOutsidePrompt(path, ctx.workingDir, root),
      );
      return refusal ?? inner.run(args, ctx);
    });
  }

  if (asker !== null && registry.has(SHELL_TOOL)) {
    const inner = registry.get(SHELL_TOOL);
    install(SHELL_TOOL, async (args, ctx) => {
      if (!scoped()) return inner.run(args, ctx);
      if (isFusionWorkerSessionId(ctx.sessionId)) {
        // A worker's world is its task's directories, and there is
        // nobody to ask: the refusal, as for its reads.
        const granted = options.grantedDirs(ctx.sessionId);
        const outside = findShellPathOutsideScope(
          args,
          ctx,
          [ctx.workingDir, ...granted],
          options.shellEnv,
        );
        return outside === null
          ? inner.run(args, ctx)
          : workerReadRefusal(SHELL_TOOL, outside, ctx, granted);
      }
      const refusal = await asker.admit(
        SHELL_TOOL,
        ctx,
        (roots) => findShellPathOutsideScope(args, ctx, roots, options.shellEnv),
        (path, root) =>
          shellReadOutsidePrompt(
            shellCommandLine(args),
            path,
            ctx.workingDir,
            root,
          ),
      );
      return refusal ?? inner.run(args, ctx);
    });
  }
  return confined;
}

/**
 * The fusion-only install: workers confined to their working directory
 * and fan-out scope, every other session untouched, the shell not
 * wrapped. Kept for callers that want exactly that; the runtime installs
 * `confineReads` with the live `agent.readScope` and the ladder instead.
 */
export function confineWorkerReads(
  registry: Pick<ToolRegistry, "has" | "get" | "register">,
  options: { grantedDirs: (sessionId: string) => readonly string[] },
): string[] {
  return confineReads(registry, { grantedDirs: options.grantedDirs });
}
