/**
 * Drive `atomic-agent run` through N consecutive user turns and
 * read the resulting trace file to extract per-turn metrics.
 *
 * Why we go through the CLI rather than constructing `AgentRuntime`
 * in-process:
 *
 *  - The CLI is the single entrypoint the agent ships with. Driving
 *    through it exercises real stdin/stdout/trace plumbing, including
 *    config bootstrap, slot reservation, reflection scheduling.
 *  - Spawning a fresh subprocess per scenario keeps `stateDir`
 *    isolation honest — there is zero risk of an in-memory singleton
 *    leaking state between ON and OFF runs.
 *
 * The chat loop in `src/cli/run-agent.ts` reads stdin line-by-line via
 * `readline`. We **cannot** pipe all turns up-front and close stdin
 * immediately — Node's readline raises `close` as soon as it sees
 * EOF, and the second `rl.question(...)` resolves to `null` before
 * the buffered second line is delivered. Result: only the first turn
 * fires, the rest are silently dropped.
 *
 * The driver therefore advances **one prompt at a time**: it sends
 * prompt N, waits for the corresponding `assistant_reply` line on
 * stdout (the agent writes exactly one `process.stdout.write(reply +
 * "\n")` per turn), then sends prompt N+1. After the last reply, we
 * close stdin so the agent's readline loop exits cleanly.
 *
 * Per-turn data (final reply, step count, tools, tokens) is then read
 * from the trace ndjson file at
 * `<stateDir>/traces/<sessionId>.ndjson` — that file is the canonical
 * source of truth for what actually happened during each turn. We do
 * not parse the stdout reply directly; stdout is only used as a
 * **synchronisation signal** between user turns.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const DIST_CLI = resolve(REPO_ROOT, "dist", "cli", "index.js");
const SRC_CLI = resolve(REPO_ROOT, "src", "cli", "index.ts");

export interface MultiTurnOptions {
  /** Absolute path to the working directory for `--cwd`. Often a temp dir. */
  workingDir: string;
  /** Absolute path to `<stateDir>` (sets `ATOMIC_AGENT_STATE_DIR`). */
  stateDir: string;
  /** User prompts, in order. One per turn. */
  prompts: readonly string[];
  /** Step cap forwarded to `--max-steps`. */
  maxSteps: number;
  /** Wall-clock cap on the whole subprocess. */
  timeoutMs: number;
  /** Additional env vars to inject. */
  env?: Readonly<Record<string, string>>;
}

export interface TurnRecord {
  /** 0-based index matching the prompt list. */
  index: number;
  userMessage: string;
  /** `assistant_reply` text from the trace, or `""` when the agent never replied. */
  assistantReply: string;
  /** Reason from `turn_finished`. `"reply" | "finish" | "cancelled" | "failed" | ...` */
  reason: string | null;
  stepCount: number;
  durationMs: number;
  promptTokens: number;
  predictedTokens: number;
  parseRetries: number;
  toolCalls: ReadonlyArray<{ tool: string; status: "ok" | "error" }>;
  cacheHits: number;
  failureCategory: string | null;
  failureMessage: string | null;
}

export interface MultiTurnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Whole-subprocess wall clock. */
  durationMs: number;
  /** Last sessionId stamped by the agent (one chat run = one session). */
  sessionId: string | null;
  turns: TurnRecord[];
  /** Raw stderr — useful for debugging when something exploded mid-run. */
  stderrTail: string;
}

export class MultiTurnDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultiTurnDriverError";
  }
}

/**
 * Resolve which entry to spawn. Prefers the compiled dist CLI; falls
 * back to `tsx src/cli/index.ts` for dev environments without build.
 */
function resolveCliCommand(): { command: string; baseArgs: string[] } {
  if (existsSync(DIST_CLI)) {
    return { command: process.execPath, baseArgs: [DIST_CLI] };
  }
  if (existsSync(TSX_BIN)) {
    return { command: TSX_BIN, baseArgs: [SRC_CLI] };
  }
  throw new MultiTurnDriverError(
    `cannot locate CLI: neither ${DIST_CLI} nor ${TSX_BIN} exist. Run \`npm run build\` first.`,
  );
}

/** Run the agent through N prompts and return per-turn metrics. */
export async function driveMultiTurn(opts: MultiTurnOptions): Promise<MultiTurnResult> {
  if (opts.prompts.length === 0) {
    throw new MultiTurnDriverError("driveMultiTurn requires at least one prompt");
  }
  const { command, baseArgs } = resolveCliCommand();
  const args = [
    ...baseArgs,
    "run",
    "--cwd",
    opts.workingDir,
    "--no-approval",
    "--max-steps",
    String(opts.maxSteps),
  ];

  const startedAt = Date.now();
  const childResult = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(opts.env ?? {}),
        ATOMIC_AGENT_STATE_DIR: opts.stateDir,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let pendingReplyResolver: ((line: string) => void) | null = null;
    let stdoutBacklog: string[] = [];

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    /**
     * Wait for the next complete stdout line (i.e. the agent's reply
     * to the prompt we just sent). Resolves with the line content
     * (without trailing newline). The reply itself may be multi-line
     * conceptually but the agent always writes it as one
     * `process.stdout.write(reply + "\n")` call, so the first
     * encountered newline on stdout always closes one turn.
     */
    const waitForNextReplyLine = (): Promise<string | null> =>
      new Promise((resolveLine) => {
        if (stdoutBacklog.length > 0) {
          resolveLine(stdoutBacklog.shift()!);
          return;
        }
        pendingReplyResolver = (line) => {
          pendingReplyResolver = null;
          resolveLine(line);
        };
        // If the process exits while we're waiting, give up.
        const onExit = () => {
          if (pendingReplyResolver) {
            pendingReplyResolver = null;
            resolveLine(null);
          }
          child.off("close", onExit);
        };
        child.once("close", onExit);
      });

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (pendingReplyResolver) {
          const r = pendingReplyResolver;
          pendingReplyResolver = null;
          r(line);
        } else {
          stdoutBacklog.push(line);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      rejectSpawn(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolveSpawn({ exitCode: code, signal, stdout, stderr, timedOut });
    });

    // Drive prompts one at a time, waiting for each reply before
    // sending the next one. After the final reply, close stdin so the
    // agent's chat loop exits.
    (async () => {
      for (let i = 0; i < opts.prompts.length; i += 1) {
        const sanitized = (opts.prompts[i] ?? "").replace(/\r?\n/g, " ").trim();
        if (!child.stdin.writable) break;
        child.stdin.write(`${sanitized}\n`);
        const line = await waitForNextReplyLine();
        if (line === null) return; // child exited mid-turn — let trace parsing handle the partial state
      }
      if (child.stdin.writable) child.stdin.end();
    })().catch(() => {
      // Swallow — the child's close handler will surface the exit code.
    });
  });

  // Prefer the trace-file fallback over the stderr summary: the CLI
  // prints the session summary via `JSON.stringify(..., null, 2)`,
  // which is multi-line, and any post-summary shutdown logs (e.g. the
  // Telegram channel turning itself off) make a naive bottom-up
  // `lines.slice(i).join("\n")` scan miss the block. One stateDir maps
  // to exactly one session in our paired runner, so picking the most
  // recently mtime'd `<stateDir>/traces/*.ndjson` is unambiguous and
  // robust against stderr ordering changes.
  const sessionId =
    findLatestTraceSessionId(opts.stateDir) ??
    extractSessionId(childResult.stderr);
  const turns = sessionId
    ? readTurnsFromTrace(opts.stateDir, sessionId, opts.prompts)
    : [];

  return {
    exitCode: childResult.exitCode,
    signal: childResult.signal,
    timedOut: childResult.timedOut,
    durationMs: Date.now() - startedAt,
    sessionId,
    turns,
    stderrTail: childResult.stderr.slice(-4000),
  };
}

function extractSessionId(stderr: string): string | null {
  const lines = stderr.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trimStart();
    if (!line.startsWith("{")) continue;
    // Scan forward from line i to find a matching closing brace, then
    // try to parse only that slice. This is resilient to trailing
    // shutdown logs after the JSON session summary.
    for (let j = i; j < lines.length; j += 1) {
      const candidate = lines.slice(i, j + 1).join("\n").trim();
      if (!candidate.endsWith("}")) continue;
      try {
        const obj = JSON.parse(candidate) as { sessionId?: string };
        if (typeof obj.sessionId === "string") return obj.sessionId;
        break;
      } catch {
        /* try a wider slice — JSON might span more lines */
      }
    }
  }
  return null;
}

/**
 * Fallback: pick the most recently modified `*.ndjson` under
 * `<stateDir>/traces/`. In every eval scenario we create a fresh
 * stateDir per run, so there is exactly one session file there and
 * its base name is the session id. This is the canonical signal that
 * a session ran, independent of whatever stderr happens to contain.
 */
function findLatestTraceSessionId(stateDir: string): string | null {
  const dir = resolve(stateDir, "traces");
  if (!existsSync(dir)) return null;
  let bestName: string | null = null;
  let bestMtime = -Infinity;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ndjson")) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      bestName = entry;
    }
  }
  return bestName ? bestName.replace(/\.ndjson$/, "") : null;
}

/**
 * Read the per-session trace file and reconstruct one `TurnRecord`
 * per element in `prompts`. We index turns by `turnIndex` from the
 * trace events; missing turns (agent crashed early) get an empty
 * record so callers can still see how far the agent got.
 */
function readTurnsFromTrace(
  stateDir: string,
  sessionId: string,
  prompts: readonly string[],
): TurnRecord[] {
  const path = resolve(stateDir, "traces", `${sessionId}.ndjson`);
  if (!existsSync(path)) {
    return prompts.map((p, i) => emptyTurn(i, p));
  }
  const raw = readFileSync(path, "utf8");
  const turns = new Map<number, TurnAccumulator>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    const turnIdxRaw = event.turnIndex;
    const turnIndex = typeof turnIdxRaw === "number" ? turnIdxRaw : null;
    if (turnIndex === null) {
      // step / llm_completion events use stepIndex; we rely on the
      // turn frame events to bucket them. Skip here — they will be
      // attributed via the `currentTurn` state below.
      continue;
    }
    let acc = turns.get(turnIndex);
    if (!acc) {
      acc = newTurnAccumulator(turnIndex);
      turns.set(turnIndex, acc);
    }
    if (type === "turn_started") {
      acc.userMessage = typeof event.userMessage === "string" ? event.userMessage : "";
    } else if (type === "turn_finished") {
      acc.reason = typeof event.reason === "string" ? event.reason : null;
      acc.stepCount = typeof event.stepCount === "number" ? event.stepCount : acc.stepCount;
      acc.durationMs = typeof event.durationMs === "number" ? event.durationMs : acc.durationMs;
    }
  }

  // Second pass — events without `turnIndex` carry their own frame
  // (step_*, llm_completion, tool_invocation, parse_retry, error).
  // We need to bracket them between turn_started / turn_finished from
  // the same session. Re-scan with a turn pointer.
  let currentTurn: TurnAccumulator | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;
    if (type === "turn_started") {
      const idx = event.turnIndex;
      if (typeof idx === "number") {
        currentTurn = turns.get(idx) ?? newTurnAccumulator(idx);
        if (!turns.has(idx)) turns.set(idx, currentTurn);
        currentTurn.userMessage =
          typeof event.userMessage === "string" ? event.userMessage : currentTurn.userMessage;
      }
      continue;
    }
    if (type === "turn_finished") {
      if (currentTurn) {
        currentTurn.reason = typeof event.reason === "string" ? event.reason : currentTurn.reason;
      }
      currentTurn = null;
      continue;
    }
    if (!currentTurn) continue;
    if (type === "prompt_captured") {
      const tokens = event.tokens as { total?: number } | undefined;
      if (tokens && typeof tokens.total === "number") {
        currentTurn.promptTokens += tokens.total;
      }
      if (event.cacheReused === true) currentTurn.cacheHits += 1;
    } else if (type === "llm_completion") {
      const timing = event.timing as { predictedTokens?: number } | undefined;
      if (timing && typeof timing.predictedTokens === "number") {
        currentTurn.predictedTokens += timing.predictedTokens;
      }
      const content = typeof event.content === "string" ? event.content : "";
      if (content.length > 0) currentTurn.lastCompletion = content;
    } else if (type === "tool_invocation") {
      const tool = typeof event.tool === "string" ? event.tool : "unknown";
      const status = event.status === "error" ? "error" : "ok";
      currentTurn.toolCalls.push({ tool, status });
      if (tool === "reply") {
        const args = event.args as { text?: string } | undefined;
        if (args && typeof args.text === "string") currentTurn.assistantReply = args.text;
      }
      if (tool === "finish") {
        const args = event.args as { final?: string; reply?: string } | undefined;
        if (args && typeof args.final === "string") currentTurn.assistantReply = args.final;
        else if (args && typeof args.reply === "string") currentTurn.assistantReply = args.reply;
      }
    } else if (type === "parse_retry") {
      currentTurn.parseRetries += 1;
    } else if (type === "step_started") {
      currentTurn.stepCount += 1;
    } else if (type === "error") {
      if (typeof event.category === "string") {
        currentTurn.failureCategory = event.category;
      }
      if (typeof event.message === "string") {
        currentTurn.failureMessage = event.message;
      }
    }
  }

  return prompts.map((p, i) => {
    const acc = turns.get(i);
    if (!acc) return emptyTurn(i, p);
    return {
      index: acc.index,
      userMessage: acc.userMessage || p,
      assistantReply: acc.assistantReply,
      reason: acc.reason,
      stepCount: acc.stepCount,
      durationMs: acc.durationMs,
      promptTokens: acc.promptTokens,
      predictedTokens: acc.predictedTokens,
      parseRetries: acc.parseRetries,
      toolCalls: acc.toolCalls,
      cacheHits: acc.cacheHits,
      failureCategory: acc.failureCategory,
      failureMessage: acc.failureMessage,
    };
  });
}

interface TurnAccumulator {
  index: number;
  userMessage: string;
  assistantReply: string;
  reason: string | null;
  stepCount: number;
  durationMs: number;
  promptTokens: number;
  predictedTokens: number;
  parseRetries: number;
  toolCalls: Array<{ tool: string; status: "ok" | "error" }>;
  cacheHits: number;
  lastCompletion: string;
  failureCategory: string | null;
  failureMessage: string | null;
}

function newTurnAccumulator(index: number): TurnAccumulator {
  return {
    index,
    userMessage: "",
    assistantReply: "",
    reason: null,
    stepCount: 0,
    durationMs: 0,
    promptTokens: 0,
    predictedTokens: 0,
    parseRetries: 0,
    toolCalls: [],
    cacheHits: 0,
    lastCompletion: "",
    failureCategory: null,
    failureMessage: null,
  };
}

function emptyTurn(index: number, userMessage: string): TurnRecord {
  return {
    index,
    userMessage,
    assistantReply: "",
    reason: null,
    stepCount: 0,
    durationMs: 0,
    promptTokens: 0,
    predictedTokens: 0,
    parseRetries: 0,
    toolCalls: [],
    cacheHits: 0,
    failureCategory: null,
    failureMessage: null,
  };
}
