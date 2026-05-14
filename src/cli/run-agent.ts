import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";

import { getConfig } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { stderrSink } from "../tracing/structured-logger.js";
import type { SessionState } from "../session/session-state.js";

interface RunArgs {
  workingDir: string;
  maxSteps: number | null;
  noApproval: boolean;
}

function parseArgs(args: string[]): RunArgs | { error: string } {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        workingDir = resolve(value);
        break;
      }
      case "--max-steps": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed))
          return { error: "--max-steps expects an integer" };
        maxSteps = parsed;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return {
    workingDir: workingDir ?? process.cwd(),
    maxSteps,
    noApproval,
  };
}

/**
 * Interactive approval over stdin. We ask the operator to confirm each
 * dangerous action; anything other than `y`/`yes` is treated as refusal.
 */
async function promptApproval(request: ApprovalRequest): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const lines = [
      "",
      `» approval required for tool: ${request.tool}`,
      `  reason: ${request.reason}`,
    ];
    if (request.preview) lines.push(`  preview: ${request.preview}`);
    if (request.affectedResources?.length) {
      lines.push(`  affects: ${request.affectedResources.join(", ")}`);
    }
    lines.push("  approve? [y/N] ");
    process.stderr.write(`${lines.join("\n")}`);
    const answer = await new Promise<string>((r) => rl.question("", r));
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function formatAgentEvent(event: AgentLoopEvent): string | null {
  switch (event.type) {
    case "user_message":
      return null;
    case "turn_started":
      return `» turn ${event.turnIndex} started`;
    case "turn_finished":
      return `» turn ${event.turnIndex} ${event.reason} (${event.stepCount} steps, ${event.durationMs}ms)`;
    case "step_started":
      return `[step ${event.stepIndex}] started`;
    case "step_finished":
      return `[step ${event.stepIndex}] ${event.summary} (${event.durationMs}ms)`;
    case "llm_event": {
      const inner = event.event;
      if (inner.type === "tool_call_parsed") {
        return `  → ${inner.call.tool}(${JSON.stringify(inner.call.args)})`;
      }
      if (inner.type === "tool_call_executed") {
        return `  ← ${inner.result.tool} ${inner.result.status}: ${inner.result.summary}${inner.result.truncated ? " (truncated)" : ""}`;
      }
      if (inner.type === "step_error") {
        return `  ! [${inner.category}] ${inner.error.message}`;
      }
      // assistant_reply / reasoning are emitted to stdout from the chat loop instead.
      return null;
    }
    case "loop_completed":
      return null;
    case "loop_failed":
      return `» loop failed [${event.category}]: ${event.error.message}`;
    default:
      return null;
  }
}

interface ChatLoopOptions {
  runtime: AgentRuntime;
  initialSession: SessionState;
  maxSteps: number;
  controller: AbortController;
}

/**
 * Read messages line-by-line from stdin and feed them through
 * `runtime.runTurn`. Assistant replies go to stdout (so a pipe captures
 * just the human-readable text); everything else stays on stderr. The
 * loop ends on EOF, `/quit`, or abort.
 */
async function runChatLoop(opts: ChatLoopOptions): Promise<SessionState> {
  let session = opts.initialSession;

  const collectReply = (): {
    onEvent: (e: AgentLoopEvent) => void;
    getReply: () => string | null;
  } => {
    let reply: string | null = null;
    return {
      onEvent: (event) => {
        if (event.type === "llm_event" && event.event.type === "assistant_reply") {
          reply = event.event.text;
        }
      },
      getReply: () => reply,
    };
  };

  const driveTurn = async (message: string): Promise<void> => {
    const collector = collectReply();
    const result = await opts.runtime.runTurn(session, message, {
      maxSteps: opts.maxSteps,
      signal: opts.controller.signal,
      origin: "cli",
      eventHook: collector.onEvent,
    });
    session = result.session;
    const reply = collector.getReply();
    if (reply !== null) {
      process.stdout.write(`${reply}\n`);
    }
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });

  const ask = (rli: ReadlineInterface): Promise<string | null> =>
    new Promise((resolvePrompt, rejectPrompt) => {
      if ((rli as { closed?: boolean }).closed === true) {
        resolvePrompt(null);
        return;
      }
      const onClose = () => resolvePrompt(null);
      rli.once("close", onClose);
      try {
        rli.question("you> ", (answer) => {
          rli.off("close", onClose);
          resolvePrompt(answer);
        });
      } catch (err) {
        rli.off("close", onClose);
        if (
          err instanceof Error &&
          err.message.toLowerCase().includes("readline was closed")
        ) {
          resolvePrompt(null);
          return;
        }
        rejectPrompt(err);
      }
    });

  try {
    while (true) {
      if (opts.controller.signal.aborted) break;
      if (session.status === "completed") break;
      const line = await ask(rl);
      if (line === null) break;
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed === "/abort") {
        opts.controller.abort();
        break;
      }
      await driveTurn(trimmed);
    }
  } finally {
    rl.close();
  }
  return session;
}

/**
 * CLI entry for `atomic-agent run`. Pure interactive chat: each stdin
 * line is one user message, each `reply` from the model becomes one
 * assistant message. `/quit` exits, `/abort` cancels the current turn.
 */
export async function runAgentCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const config = getConfig();
  const approvalRequired = !parsed.noApproval && config.agent.approvalRequired;

  let approvalChain: Promise<unknown> = Promise.resolve();

  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalRequired,
    traceDefault: true,
    handlers: {
      onAgentEvent: (event) => {
        // Per-turn assistant-reply collection is wired through the
        // `eventHook` argument of `runTurn` (see `driveTurn`). This
        // global handler only feeds the diagnostic stderr stream so
        // the operator can watch the macro-turn lifecycle.
        const line = formatAgentEvent(event);
        if (line) process.stderr.write(`${line}\n`);
      },
      onApprovalRequest: (request) => {
        approvalChain = approvalChain.then(async () => {
          const approved = await promptApproval(request);
          runtime.approvals.resolve({
            approvalId: request.approvalId,
            approved,
            reason: approved ? "cli-approved" : "cli-denied",
          });
        });
      },
      onChannelStatus: (status) => {
        const suffix =
          status.lastError && status.state === "down"
            ? `: ${status.lastError}`
            : "";
        process.stderr.write(`[${status.channel}] ${status.state}${suffix}\n`);
      },
      logSinks: [stderrSink()],
    },
  });

  process.stderr.write(
    `atomic-agent run (chat)\n` +
      `  cwd:     ${parsed.workingDir}\n` +
      `  llama:   ${config.localModels.url}\n` +
      `  browser: ${config.browser.channel}${config.browser.headless ? " (headless)" : ""}\n` +
      `  skills:  ${runtime.skillCatalog.length} installed\n` +
      `  approval:${approvalRequired ? " interactive" : " disabled"}\n` +
      `  type /quit to exit, /abort to cancel current turn\n`,
  );

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let exitCode = 0;
  try {
    const session = runtime.createSession();
    const finalSession = await runChatLoop({
      runtime,
      initialSession: session,
      maxSteps: parsed.maxSteps ?? config.agent.maxSteps,
      controller,
    });
    runtime.sessionStore.save(finalSession);
    process.stderr.write(
      `${JSON.stringify(
        {
          sessionId: finalSession.id,
          status: finalSession.status,
          turnCount: finalSession.turnCount,
          stepCount: finalSession.stepCount,
          lastError: finalSession.lastError,
        },
        null,
        2,
      )}\n`,
    );
    if (finalSession.status === "failed") exitCode = 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`fatal: ${msg}\n`);
    exitCode = 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.shutdown();
  }
  return exitCode;
}
