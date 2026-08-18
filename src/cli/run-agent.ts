import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";

import {
  formatApprovalCategory,
  formatApprovalLevel,
  resolveBootApprovalLevel,
} from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { stderrSink } from "../tracing/structured-logger.js";
import type { SessionState } from "../session/session-state.js";

interface RunArgs {
  workingDir: string;
  maxSteps: number | null;
  noApproval: boolean;
}

const HELP =
  [
    "atomic-agent run — chat with the agent over stdin",
    "",
    "Usage:",
    "  atomic-agent run [options]           interactive: one message per line",
    "  echo \"<goal>\" | atomic-agent run     one-shot: answer on stdout, logs on stderr",
    "",
    "Options:",
    "  --cwd <dir>          Working directory for OS tools (default: current directory)",
    "  --working-dir <dir>  Alias for --cwd",
    "  --max-steps <n>      Step budget for one turn (default: agent.maxSteps from config)",
    "  --no-approval        Force approval level 5: auto-approve every dangerous tool call",
    "",
    "In-session:  /quit exits · /abort cancels the current turn",
    "Exit codes:  0 replied · 1 failed · 2 usage error",
  ].join("\n") + "\n";

function parseArgs(args: string[]): RunArgs | { error: string } | { help: true } {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "--help":
      case "-h":
        return { help: true };
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        const resolved = resolve(value);
        // A typo'd path used to sail through: the run booted, printed the
        // bogus directory in its banner as though healthy, ENOENT'd on
        // every filesystem tool until the step budget ran out — and then
        // exited 0. Catch it before anything boots.
        let isDirectory = false;
        try {
          isDirectory = statSync(resolved).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) {
          return { error: `${flag} is not a directory: ${resolved}` };
        }
        workingDir = resolved;
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

interface CliApprovalAnswer {
  approved: boolean;
  grant?: ApprovalGrantScope;
}

/**
 * Interactive approval over stdin. We ask the operator to confirm each
 * dangerous action; `y`/`yes` approves this call, `s` also grants the
 * category for the session, `a` grants this shell command shape.
 * Anything else is a refusal. The grant options mirror the TUI prompt;
 * they are offered here too because a CLI operator has the same physical
 * access to the machine. `trust_config` is never grantable, so those
 * requests only ever show `y/N`.
 */
async function promptApproval(
  request: ApprovalRequest,
): Promise<CliApprovalAnswer> {
  const grantCategory = canGrantCategory(request);
  const grantShape = canGrantShape(request);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const lines = [
      "",
      `» approval required for tool: ${request.tool}`,
      `  kind: ${formatApprovalCategory(request.category)}`,
      `  reason: ${request.reason}`,
    ];
    if (request.preview) lines.push(`  preview: ${request.preview}`);
    if (request.affectedResources?.length) {
      lines.push(`  affects: ${request.affectedResources.join(", ")}`);
    }
    const options = ["y = approve once"];
    if (grantCategory) options.push("s = allow this kind this session");
    if (grantShape) {
      options.push(`a = allow all ${request.commandShape} this session`);
    }
    options.push("N = deny");
    if (!grantCategory) {
      lines.push(
        "  (trust-config writes are never granted for the session)",
      );
    }
    lines.push(`  approve? [${options.join(", ")}] `);
    process.stderr.write(`${lines.join("\n")}`);
    const answer = (await new Promise<string>((r) => rl.question("", r)))
      .trim()
      .toLowerCase();
    if (answer === "s" && grantCategory) {
      process.stderr.write(
        `\n  granted: ${formatApprovalCategory(request.category)} for this session\n`,
      );
      return { approved: true, grant: "category" };
    }
    if (answer === "a" && grantShape) {
      process.stderr.write(
        `\n  granted: ${request.commandShape} commands for this session\n`,
      );
      return { approved: true, grant: "shape" };
    }
    return { approved: /^(y|yes)$/.test(answer) };
  } finally {
    rl.close();
  }
}

/** Transport failures that mean "nothing answered at the configured URL". */
const TRANSPORT_NO_ANSWER = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|timeout/i;

function withLlamaHint(
  base: string,
  category: string,
  message: string,
  ctx?: { llamaHint?: string | null; hintShown?: { value: boolean } },
): string {
  if (!ctx?.llamaHint || ctx.hintShown?.value) return base;
  if (category !== "transport" || !TRANSPORT_NO_ANSWER.test(message)) return base;
  if (ctx.hintShown) ctx.hintShown.value = true;
  const indented = ctx.llamaHint
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `${base}\n${indented}`;
}

/**
 * Render one agent-loop event as a diagnostic stderr line, or null for
 * events other surfaces own. Exported for tests.
 *
 * `ctx.llamaHint` carries the actionable llama-server message when the
 * active text route is the local server: a transport failure there is
 * almost always "llama-server is not running", and the raw undici string
 * ("fetch failed") tells the operator none of URL / cause / fix. The hint
 * is appended once per process — every retry repeating three lines of
 * advice would bury the log.
 */
export function formatAgentEvent(
  event: AgentLoopEvent,
  ctx?: { llamaHint?: string | null; hintShown?: { value: boolean } },
): string | null {
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
        const base = `  ! [${inner.category}] ${inner.error.message}`;
        return withLlamaHint(base, inner.category, inner.error.message, ctx);
      }
      // assistant_reply / reasoning are emitted to stdout from the chat loop instead.
      return null;
    }
    case "loop_completed":
      return null;
    case "loop_failed": {
      const base = `» loop failed [${event.category}]: ${event.error.message}`;
      return withLlamaHint(base, event.category, event.error.message, ctx);
    }
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
      // Collapse embedded newlines into spaces so the "exactly one
      // stdout line per turn" invariant holds even when the model
      // emits markdown bullet lists or other multi-line content. A
      // line-synchronised driver (`eval-memory/harness/multi-turn-driver.ts`)
      // splits stdout on `\n` and feeds extra lines into its backlog,
      // which on the next prompt resolve *immediately* as fake replies
      // and slide the prompt↔reply pairing by one slot per embedded
      // newline. Reply text destined for analysis lives in the trace
      // file (`tool_invocation.args.text`); stdout is purely a sync
      // channel, so flattening newlines does not lose data.
      const singleLine = reply.replace(/\r?\n/g, " ");
      process.stdout.write(`${singleLine}\n`);
    } else {
      // No assistant_reply was emitted this turn (failed / cancelled /
      // max_steps with no reply). Still write a single newline so the
      // "exactly one stdout line per turn" invariant holds for any
      // line-synchronised driver — the diagnostic detail already went
      // to stderr via formatAgentEvent.
      process.stdout.write("\n");
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
  if ("help" in parsed) {
    process.stdout.write(HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const config = getConfig();
  const approvalLevel = resolveBootApprovalLevel(
    parsed.noApproval,
    config.agent.approvalLevel,
  );

  let approvalChain: Promise<unknown> = Promise.resolve();

  // The hint only applies when a transport failure means "local llama is
  // down" — i.e. the active text route IS the local server. On a cloud
  // route the same category points at the provider, not at llama.
  const llamaHint =
    resolveLlmConfig(config).activeTextProvider === "local-llama"
      ? formatLlamaUnreachableHint(config.localModels.url)
      : null;
  const hintShown = { value: false };

  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalLevel,
    traceDefault: true,
    handlers: {
      onAgentEvent: (event) => {
        // Per-turn assistant-reply collection is wired through the
        // `eventHook` argument of `runTurn` (see `driveTurn`). This
        // global handler only feeds the diagnostic stderr stream so
        // the operator can watch the macro-turn lifecycle.
        const line = formatAgentEvent(event, { llamaHint, hintShown });
        if (line) process.stderr.write(`${line}\n`);
      },
      onApprovalRequest: (request) => {
        approvalChain = approvalChain.then(async () => {
          const answer = await promptApproval(request);
          runtime.approvals.resolve({
            approvalId: request.approvalId,
            approved: answer.approved,
            reason: answer.approved ? "cli-approved" : "cli-denied",
            ...(answer.grant ? { grant: answer.grant } : {}),
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
      `  approval: level ${formatApprovalLevel(approvalLevel)}\n` +
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
    // `stalled` means the step budget ran out with nothing produced —
    // that is not success, and a CI job watching this exit code must not
    // read it as one. Only `completed` (and a clean EOF on an idle
    // session) count as 0.
    if (finalSession.status === "failed" || finalSession.status === "stalled") {
      exitCode = 1;
    }
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
