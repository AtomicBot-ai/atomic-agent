import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { stderrSink } from "../tracing/structured-logger.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import { HELP, parseArgs } from "./serve-args.js";
import { watchForOrphaning } from "./serve-orphan-guard.js";
import {
  formatReapOutcomes,
  registerServe,
  reapOrphanedServes,
} from "./serve-reaper.js";

import {
  ApprovalBus,
  buildRouteTable,
  CompletionRegistry,
  createHttpServer,
} from "../http/index.js";
import type { HttpServerHandle } from "../http/index.js";

/**
 * Entry point for `atomic-agent serve`. Boots the shared agent runtime
 * once, wires it to an HTTP-facing approval bus, starts the server,
 * and hands control to the host process until SIGINT/SIGTERM. Per-turn
 * concurrency is owned by `runtime.turnController`, so HTTP requests on
 * different sessions run in parallel while same-session requests
 * serialise FIFO automatically.
 */
export async function serveCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`serve: ${parsed.error}\n`);
    process.stderr.write(HELP);
    return 1;
  }

  const stateDir = getConfig().paths.stateDir;
  if (parsed.reapOnly) {
    process.stdout.write(formatReapOutcomes(await reapOrphanedServes({ stateDir })));
    return 0;
  }

  const approvalBus = new ApprovalBus();
  const completionRegistry = new CompletionRegistry();

  let runtime: AgentRuntime | null = null;
  let handle: HttpServerHandle | null = null;
  let releaseRecord: (() => void) | null = null;
  let orphanWatch: OrphanWatch | null = null;
  try {
    runtime = await createAgentRuntime({
      workingDir: parsed.workingDir,
      // Same boot contract as `run` and `tui`: the persisted
      // `agent.approvalLevel` is the baseline and `--no-approval` can
      // only force level 5 (approve everything) for this process, never
      // a stricter level. Keeping serve on this rule makes the Privacy
      // tab's "persists to config.json and applies to future runs too"
      // promise hold for every interactive entry point.
      approvalLevel: resolveBootApprovalLevel(
        parsed.noApproval,
        getConfig().agent.approvalLevel,
      ),
      traceDefault: true,
      handlers: {
        logSinks: [stderrSink],
        onApprovalRequest: (request) => approvalBus.publish(request),
      },
    });
    handle = await createHttpServer({
      runtime,
      host: parsed.host,
      port: parsed.port,
      apiKey: parsed.apiKey,
      routes: buildRouteTable(),
      approvalBus,
      completionRegistry,
    });
    const authNote = parsed.apiKey ? "auth=bearer" : "auth=none";
    process.stderr.write(
      `[atomic-agent] serve listening on http://${handle.host}:${handle.port} (${authNote}, cwd=${parsed.workingDir})\n`,
    );

    releaseRecord = registerServe(stateDir, {
      pid: process.pid,
      bootPpid: process.ppid,
      // A server that is told to outlive its parent, or that had none to
      // begin with, is a daemon on purpose and must never be swept.
      daemon: parsed.noParentExit || process.ppid <= 1,
      host: handle.host,
      port: handle.port,
      cwd: parsed.workingDir,
      startedAt: new Date().toISOString(),
    });
    // Each new server tidies up after the generation before it. Failures
    // here are never fatal — the sweep is housekeeping, not startup — and
    // it is deliberately not awaited, because a stray that needs the full
    // SIGTERM grace would otherwise hold up serving traffic.
    void reapOrphanedServes({ stateDir }).catch(() => []);

    const liveRuntime = runtime;
    orphanWatch = parsed.noParentExit
      ? null
      : waitForOrphaning(
          () => liveRuntime.turnController.busySessionIds().length > 0,
          parsed.parentPid ?? undefined,
        );

    await Promise.race([
      waitForShutdownSignal().then((signal) => {
        process.stderr.write(`[atomic-agent] ${signal} received, closing\n`);
      }),
      orphanWatch?.orphaned ?? new Promise<void>(() => {}),
    ]);
    return 0;
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`serve failed: ${message}\n`);
    return 1;
  } finally {
    orphanWatch?.stop();
    if (handle) await handle.close();
    if (runtime) await runtime.shutdown();
    // Released last, and only once the port and the databases are
    // actually let go. A teardown that wedges must stay on record:
    // a process still holding its port with no record is precisely the
    // invisible stray this module exists to prevent.
    releaseRecord?.();
  }
}

interface OrphanWatch {
  /** Resolves once the parent is gone and no turn is in flight. */
  readonly orphaned: Promise<void>;
  readonly stop: () => void;
}

/**
 * Bridge the orphan watch into the same shape as `waitForShutdownSignal`,
 * so the two ways a serve can end race against each other and share one
 * teardown path.
 */
function waitForOrphaning(isBusy: () => boolean, parentPid?: number): OrphanWatch {
  let stop = (): void => {};
  const orphaned = new Promise<void>((resolveOrphaned) => {
    stop = watchForOrphaning({
      parentPid,
      isBusy,
      onOrphanedWhileBusy: () =>
        process.stderr.write(
          "[atomic-agent] parent exited; finishing the turn in flight before closing\n",
        ),
      onOrphaned: () => {
        process.stderr.write(
          "[atomic-agent] parent exited and no turn is running, closing\n",
        );
        resolveOrphaned();
      },
    });
  });
  return { orphaned, stop: () => stop() };
}

/**
 * Resolve the returned promise when SIGINT or SIGTERM is received.
 * We do not install the listeners permanently — they come down with
 * the process. This keeps the command well-behaved when invoked from
 * a test harness that wants to `cancel()` via a different channel.
 */
function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolvePromise) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolvePromise(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
