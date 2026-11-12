import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { createStderrSink } from "../tracing/structured-logger.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import { HELP, lanUrls, parseArgs, serveAuthWarning } from "./serve-args.js";
import {
  MEMORY_GUARD_EXIT_CODE,
  memoryGuardDisabled,
  startServeMemoryGuard,
  type ServeMemoryGuard,
} from "./serve-memory-guard.js";
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
  // ATO-1419: the memory guard ended this serve; its task runs are left as crashed.
  let crashedShutdown = false;
  let handle: HttpServerHandle | null = null;
  let releaseRecord: (() => void) | null = null;
  let orphanWatch: OrphanWatch | null = null;
  let memoryGuard: ServeMemoryGuard | null = null;
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
      // A host that died (the desktop app, Force Quit) leaves stderr a
      // dead pipe. The next log line used to exit the process there and
      // then, skipping the `finally` below — the port, the session
      // store's turn ends, the serve record. Muted, serve goes on until
      // the orphan watch ends it through that teardown.
      brokenPipe: "mute",
      handlers: {
        // The structured log goes to stderr, which a host running serve
        // relays into its own log (the desktop app's agent.log and its
        // Diagnostics pane); `config.log.level` still decides what is
        // written. Serve once passed `stderrSink` here, the factory and
        // not the sink it builds, and nothing was ever written: the
        // factory's parameter makes that a compile error now, and
        // `serve-command.test.ts` reads what is passed here.
        logSinks: [createStderrSink()],
        onApprovalRequest: (request) => {
          // ATO-1111: drop mirrored prompts whose turn was aborted, so a
          // window that never reconnects /api/events does not keep them.
          const live = runtime;
          if (live) approvalBus.prune((r) => live.approvals.isPending(r.approvalId));
          approvalBus.publish(request);
        },
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
    const authWarning = serveAuthWarning(parsed);
    if (authWarning) process.stderr.write(authWarning);
    // ATO-1126: on every interface, say where another device reaches it (the desktop's remote agent, a phone).
    for (const url of lanUrls(parsed.host, handle.port)) {
      process.stderr.write(`[atomic-agent] serve reachable at ${url}\n`);
    }

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

    // ATO-1111: end through the teardown below, with its own exit code,
    // before the OS refuses memory (Windows 0xC000009A) and kills it mid-write.
    memoryGuard = memoryGuardDisabled()
      ? null
      : startServeMemoryGuard({
          isBusy: () => liveRuntime.turnController.busySessionIds().length > 0,
          // A daemon has no supervisor to start it again: it only reports the line.
          exitAllowed: !(parsed.noParentExit || process.ppid <= 1),
        });
    let exitCode = 0;
    await Promise.race([
      waitForShutdownSignal().then((signal) => {
        process.stderr.write(`[atomic-agent] ${signal} received, closing\n`);
      }),
      orphanWatch?.orphaned ?? new Promise<void>(() => {}),
      memoryGuard?.exhausted.then(() => {
        exitCode = MEMORY_GUARD_EXIT_CODE;
        crashedShutdown = true;
      }) ?? new Promise<void>(() => {}),
    ]);
    return exitCode;
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`serve failed: ${message}\n`);
    return 1;
  } finally {
    memoryGuard?.stop();
    orphanWatch?.stop();
    if (handle) await handle.close();
    if (runtime) await runtime.shutdown(crashedShutdown ? { crashed: true } : undefined);
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
