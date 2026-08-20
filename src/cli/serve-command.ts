import { resolve } from "node:path";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { stderrSink } from "../tracing/structured-logger.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import {
  ApprovalBus,
  buildRouteTable,
  CompletionRegistry,
  createHttpServer,
} from "../http/index.js";
import type { HttpServerHandle } from "../http/index.js";

interface ServeArgs {
  host: string;
  port: number;
  workingDir: string;
  apiKey: string | null;
  noApproval: boolean;
}

const HELP =
  [
    "atomic-agent serve — start the OpenAI-compatible HTTP API",
    "",
    "Usage:",
    "  atomic-agent serve [options]",
    "",
    "Options:",
    "  --host <h>          Listen host (default 127.0.0.1)",
    "  --port <p>          Listen port (default 8787)",
    "  --cwd <dir>         Working directory for OS tools / sessions (default: cwd)",
    "  --api-key <k>       Require this bearer token on all routes except /health and /v1/models",
    "                      (falls back to env ATOMIC_AGENT_API_KEY when flag is omitted)",
    "  --no-approval       Force approval level 5: auto-approve every dangerous tool call (dev / trusted use only)",
    "",
    "Endpoints (authenticated unless noted):",
    "  POST /v1/chat/completions                OpenAI Chat Completions API (stream or sync)",
    "  POST /v1/chat/completions/{id}/cancel    Abort a streaming completion",
    "  GET  /v1/models                          Single-model catalog (public)",
    "  GET  /health                             Liveness + llama-server reachability (public)",
    "  GET  /api/capabilities                   Runtime wiring summary",
    "  GET|PATCH /api/config                    Read or merge-write the user config file",
    "  GET  /api/skills, GET /api/skills/{name} List or inspect installed skills",
    "  POST /api/skills/install, /uninstall     Manage installed skills",
    "  GET  /api/sessions, GET /api/sessions/{id}, DELETE /api/sessions/{id}",
    "  POST /api/sessions/{id}/steer            Fold a message into the turn already running",
    "  GET  /api/sessions/{id}/steer            Steers a turn accepted but never delivered",
    "  DELETE /api/sessions/{id}/steer          Acknowledge those: ?through={seq} and/or ?discarded={n}",
    "  POST /api/approval/resolve               Resolve a pending approval",
    "  GET  /api/events                         SSE stream of pending approval requests",
  ].join("\n") + "\n";

function parseArgs(args: string[]): ServeArgs | { help: true } | { error: string } {
  let host = "127.0.0.1";
  let port = 8787;
  let workingDir: string | null = null;
  let apiKey: string | null = null;
  let apiKeyProvided = false;
  let noApproval = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "-h":
      case "--help":
        return { help: true };
      case "--host": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        host = value;
        break;
      }
      case "--port": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          return { error: "--port expects an integer in 0..65535" };
        }
        port = parsed;
        break;
      }
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        workingDir = resolve(value);
        break;
      }
      case "--api-key": {
        const value = args[++i];
        if (value === undefined) return { error: "--api-key requires a value" };
        apiKey = value;
        apiKeyProvided = true;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (!apiKeyProvided) {
    const envKey = process.env.ATOMIC_AGENT_API_KEY;
    apiKey = envKey && envKey.length > 0 ? envKey : null;
  }
  return {
    host,
    port,
    workingDir: workingDir ?? process.cwd(),
    apiKey,
    noApproval,
  };
}

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

  const approvalBus = new ApprovalBus();
  const completionRegistry = new CompletionRegistry();

  let runtime: AgentRuntime | null = null;
  let handle: HttpServerHandle | null = null;
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

    await waitForShutdownSignal();
    process.stderr.write(`[atomic-agent] shutdown signal received, closing\n`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`serve failed: ${message}\n`);
    return 1;
  } finally {
    if (handle) await handle.close();
    if (runtime) await runtime.shutdown();
  }
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
