import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { refuseApproval } from "./serve-refuse-approvals.js";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { McpElicitationBroker } from "../mcp/mcp-elicitation-broker.js";
import { createStderrSink } from "../tracing/structured-logger.js";
import { registerProcessSecret } from "../error-reporting/process-secrets.js";
import { PrometheusRegistry } from "../tracing/prometheus-registry.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import { HELP, lanUrls, parseArgs } from "./serve-args.js";
import { resolveServeApiKey, serveApiKeyNotice } from "./serve-api-key.js";
import { watchForOrphaning } from "./serve-orphan-guard.js";
import {
  startWebhookTunnel,
  tunnelPreflight,
  type TunnelPreflight,
  type WebhookTunnel,
} from "./serve-webhook-tunnel.js";
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
  createHttpTokenSource,
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

  // Always a key, on loopback too: the operator's, else the persisted one
  // made on the first run. No key, no server.
  const apiKey = resolveServeApiKey(parsed.apiKey, stateDir);
  if ("error" in apiKey) {
    process.stderr.write(`serve: ${apiKey.error}\n`);
    return 1;
  }
  if (parsed.printApiKey) {
    process.stdout.write(`${apiKey.key}\n`);
    return 0;
  }
  // ATO-1705: name the key to the masker, wherever it came from (a key
  // from --api-key or the key file is in no env variable), so tool output,
  // traces and the transcript show `[redacted:serve-api-key]` in its place
  // (a `ps` listing, a log the agent reads back).
  registerProcessSecret("serve-api-key", apiKey.key);
  // Read once, then out of the environment: every child serve starts
  // (hooks, llama-server, a browser, cloudflared, a CLI provider) would
  // otherwise inherit it, not only the shell tool that already drops it.
  // This stops inheritance only: the launch environment itself stays
  // readable by the same user (/proc/<pid>/environ on Linux, `ps eww` on
  // macOS), since unsetenv does not touch the original env block.
  delete process.env.ATOMIC_AGENT_API_KEY;

  // ATO-625: refuse the tunnel before anything boots, so a missing
  // cloudflared or a webhook set with no secret never opens a public address.
  let tunnelCheck: Extract<TunnelPreflight, { ok: true }> | null = null;
  if (parsed.tunnel) {
    const config = getConfig();
    const check = tunnelPreflight({
      webhooks: config.webhooks,
      tasksEnabled: config.tasks.enabled,
    });
    if (!check.ok) {
      process.stderr.write(`serve: ${check.error}\n`);
      return 1;
    }
    tunnelCheck = check;
  }

  const approvalBus = new ApprovalBus();
  const completionRegistry = new CompletionRegistry();
  // ATO-1492: MCP servers' questions to the person ("confirm?", a small
  // form). A window shows them only when it opens /api/events with
  // `?elicitation=1`; with none open the surface is `none` and every
  // question is declined at once, which is what an unattended serve
  // must do. Never routed through the approval gate: that one can
  // answer by itself, a server's question must not be.
  const elicitations = new McpElicitationBroker();
  // ATO-646: what `GET /metrics` reports, folded in memory from the
  // runtime's metric samples.
  const metricsRegistry = new PrometheusRegistry();

  let runtime: AgentRuntime | null = null;
  let handle: HttpServerHandle | null = null;
  let releaseRecord: (() => void) | null = null;
  let orphanWatch: OrphanWatch | null = null;
  let tunnel: WebhookTunnel | null = null;
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
        metricSinks: [metricsRegistry.sink],
        onApprovalRequest: (request) => {
          // ATO-2172: a serve for a launched coding CLI has nobody to ask.
          if (parsed.refuseApprovals && runtime) {
            refuseApproval(runtime.approvals, request);
            return;
          }
          // ATO-1111: drop mirrored prompts whose turn was aborted, so a
          // window that never reconnects /api/events does not keep them.
          const live = runtime;
          if (live) approvalBus.prune((r) => live.approvals.isPending(r.approvalId));
          approvalBus.publish(request);
        },
        onMcpElicitation: elicitations,
      },
    });
    const namedTokens = createHttpTokenSource(stateDir);
    handle = await createHttpServer({
      runtime,
      host: parsed.host,
      port: parsed.port,
      apiKey: apiKey.key,
      routes: buildRouteTable({
        metricsRegistry,
        // ATO-693: off unless --a2a; parseArgs already refused it without a key.
        a2a: parsed.a2a ? { publicUrl: a2aPublicUrl() } : null,
      }),
      approvalBus,
      completionRegistry,
      elicitations,
      // ATO-583: `atag http tokens add` names tokens with a role; the key stays admin.
      namedTokens,
    });
    const baseUrl = `http://${handle.host}:${handle.port}`;
    // ATO-583 named tokens beside the always-on key (serve always has a key now).
    const named = namedTokens().length;
    const authNote = `auth=bearer${named > 0 ? `+${named} named` : ""}`;
    process.stderr.write(
      `[atomic-agent] serve listening on ${baseUrl} (${authNote}, cwd=${parsed.workingDir})\n`,
    );
    if (parsed.a2a) {
      process.stderr.write(
        "[atomic-agent] a2a: agent card at /.well-known/agent-card.json, tasks on POST /api/a2a (bearer auth)\n",
      );
    }
    process.stderr.write(serveApiKeyNotice(apiKey, baseUrl, process.stderr.isTTY === true));
    // ATO-1126: on every interface, say where another device reaches it (the desktop's remote agent, a phone).
    for (const url of lanUrls(parsed.host, handle.port)) {
      process.stderr.write(`[atomic-agent] serve reachable at ${url}\n`);
    }
    if (parsed.tunnel && tunnelCheck) {
      tunnel = await startWebhookTunnel({
        runtime,
        request: parsed.tunnel,
        preflight: tunnelCheck,
        apiKey: apiKey.key,
        approvalBus,
        completionRegistry,
        write: (line) => process.stderr.write(line),
      });
      process.stderr.write(
        `[atomic-agent] tunnel: starting cloudflared (${parsed.tunnel.mode}) for webhooks only, gateway on 127.0.0.1:${tunnel.gatewayPort}\n`,
      );
      // Not awaited: the public address can take a few seconds, and the
      // local API serves meanwhile. The outcome is logged and shown on
      // GET /api/webhooks.
      void tunnel.ready;
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
    // ATO-1688: before the connections drop and abort their turns, so a
    // turn the stop cuts off is recorded as interrupted, not as a Stop.
    runtime?.beginShutdown?.();
    elicitations.closeAll();
    // The public address goes first, before the API it fronts.
    if (tunnel) await tunnel.stop().catch(() => {});
    if (handle) await handle.close();
    if (runtime) await runtime.shutdown();
    // Released last, and only once the port and the databases are
    // actually let go. A teardown that wedges must stay on record:
    // a process still holding its port with no record is precisely the
    // invisible stray this module exists to prevent.
    releaseRecord?.();
  }
}

/** ATO-693: `ATOMIC_AGENT_A2A_PUBLIC_URL`, the address the agent card names; unset or blank is none. */
function a2aPublicUrl(): string | null {
  const raw = process.env.ATOMIC_AGENT_A2A_PUBLIC_URL?.trim();
  return raw ? raw : null;
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
