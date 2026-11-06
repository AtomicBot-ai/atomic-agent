import type { AgentLoopEvent } from "./agent-contract.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { classifyTestCommand } from "./test-command-key.js";

/**
 * Status snapshot of a running turn (ATO-965): the short answer to "what
 * is it doing right now?" that `/status` prints in the TUI, the desktop
 * and Telegram, and that long turns post on their own every N steps or
 * M minutes.
 *
 *   Plan: 5/8 · Now: integration tests
 *   Last result: tests passed
 *   Blocked: no · 2h 14m · 23 steps
 *
 * Everything here is built from the harness's own record of the turn
 * (events, step counters, the approval surface), never from the model's
 * prose. Labels use stable identifiers only (tool names, "tests passed",
 * exit codes): a snapshot can land in Telegram history, which is
 * forwardable, so raw tool output (paths, grep hits, file contents) is
 * never echoed. A caller that wants richer wording (the step verbs of
 * ATO-962, `describeToolCall`) passes its own `describe`.
 *
 * Plan progress is read structurally: the live plan (ATO-486) emits a
 * `plan_updated` event carrying `{ plan: { items: { status }[] } }`, and
 * any caller holding a `planProgress(...)` result can hand it in as
 * `plan`. Nothing here imports the plan module, so this file compiles
 * with or without it.
 */

/** What `planProgress(snapshot)` returns (ATO-486), typed structurally. */
export interface PlanProgressLike {
  done: number;
  total: number;
  current?: string;
}

/** The inputs a snapshot is built from. Every field but the counters is optional. */
export interface TurnStatusState {
  /** A turn is in flight. `false`: the snapshot describes the last one. */
  running: boolean;
  /** When the turn started (ms epoch); `null` when unknown. */
  startedAt: number | null;
  /** When it ended, for a finished turn; elapsed time stops there. */
  endedAt?: number | null;
  /** Steps finished (or started, for surfaces that only count those). */
  steps: number;
  plan?: PlanProgressLike | null;
  /** What the turn is doing now, e.g. "Running os.shell.run". */
  current?: string | null;
  /** The last tool result, already worded. */
  lastResult?: { text: string; ok: boolean } | null;
  /** The tool waiting on the person's approval, when one is. */
  blockedOn?: string | null;
}

export interface StatusSnapshot {
  running: boolean;
  planLine?: string;
  currentLine?: string;
  lastResultLine?: string;
  blockedLine?: string;
  elapsedMs: number;
  steps: number;
}

export type StatusChannel = "tui" | "desktop" | "telegram";

/** Longest a free-text fragment (plan step, current step) may run. */
const FRAGMENT_MAX_CHARS = 80;

export function buildStatusSnapshot(
  state: TurnStatusState,
  now: number = Date.now(),
): StatusSnapshot {
  const end = state.running ? now : (state.endedAt ?? now);
  const elapsedMs =
    state.startedAt === null ? 0 : Math.max(0, end - state.startedAt);
  const snap: StatusSnapshot = {
    running: state.running,
    elapsedMs,
    steps: Math.max(0, Math.floor(state.steps)),
  };
  const plan = state.plan;
  if (plan && plan.total > 0) {
    const done = Math.min(Math.max(0, plan.done), plan.total);
    snap.planLine = `Plan: ${done}/${plan.total}`;
  }
  const doing = state.running
    ? (state.blockedOn
        ? `waiting for your approval of ${state.blockedOn}`
        : (plan?.current ?? state.current ?? null))
    : null;
  if (doing !== null && doing.trim().length > 0) {
    snap.currentLine = `Now: ${clipOneLine(doing, FRAGMENT_MAX_CHARS)}`;
  } else if (state.running) {
    snap.currentLine = "Now: thinking";
  }
  if (state.lastResult) {
    snap.lastResultLine = `Last result: ${clipOneLine(state.lastResult.text, FRAGMENT_MAX_CHARS)}`;
  }
  if (state.running) {
    snap.blockedLine = state.blockedOn
      ? `Blocked: yes, on your approval of ${state.blockedOn}`
      : "Blocked: no";
  }
  return snap;
}

/**
 * Three short lines (two when nothing has a result yet). Plain text on
 * every channel: a snapshot is channel infrastructure, not agent
 * content, so Telegram never runs it through the HTML converter. The
 * channel only changes the idle wording.
 */
export function formatStatusSnapshot(
  snap: StatusSnapshot,
  channel: StatusChannel,
): string {
  const time = formatElapsed(snap.elapsedMs);
  const steps = `${snap.steps} step${snap.steps === 1 ? "" : "s"}`;
  if (!snap.running) {
    const head =
      channel === "telegram"
        ? "No turn is running in this chat."
        : "No turn is running.";
    if (snap.steps === 0 && snap.elapsedMs === 0) return head;
    const tail = [`Last turn: ${steps} · ${time}`];
    if (snap.lastResultLine) tail.push(snap.lastResultLine);
    return [head, ...tail].join("\n");
  }
  const first = [snap.planLine, snap.currentLine].filter(
    (part): part is string => typeof part === "string",
  );
  const lines = [first.join(" · ")];
  if (snap.lastResultLine) lines.push(snap.lastResultLine);
  lines.push([snap.blockedLine ?? "Blocked: no", time, steps].join(" · "));
  return lines.filter((line) => line.length > 0).join("\n");
}

/** `40s`, `5m 03s`, `2h 14m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// Live tracker: folds a turn's events into a `TurnStatusState`.
// ---------------------------------------------------------------------------

/** Optional richer wording (the step verbs of ATO-962), typed structurally. */
export type DescribeToolCall = (input: {
  name: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
}) => { line: string };

export interface TurnStatusTracker {
  /** Feed every event of the turn (install as, or call from, its `eventHook`). */
  onEvent(event: AgentLoopEvent): void;
  /**
   * The approval surface says a call is waiting on the person (`tool`),
   * or that nothing is (`null`). The loop itself emits no event for
   * this; each surface knows it from its own approval bridge.
   */
  setBlockedOn(tool: string | null): void;
  state(): TurnStatusState;
}

export function createTurnStatusTracker(options: {
  now?: () => number;
  /** Stamp the start up front (the surface knows when it sent the turn). */
  startedAt?: number;
  describe?: DescribeToolCall;
} = {}): TurnStatusTracker {
  const now = options.now ?? Date.now;
  const describe = options.describe;
  let running = options.startedAt !== undefined;
  let startedAt: number | null = options.startedAt ?? null;
  let endedAt: number | null = null;
  let steps = 0;
  let plan: PlanProgressLike | null = null;
  let current: string | null = null;
  let lastResult: { text: string; ok: boolean } | null = null;
  let blockedOn: string | null = null;

  const begin = (): void => {
    if (startedAt === null) startedAt = now();
    running = true;
  };
  const end = (): void => {
    if (!running) return;
    running = false;
    endedAt = now();
    current = null;
    blockedOn = null;
  };

  return {
    onEvent(event) {
      const loose = event as { type: string; plan?: unknown };
      if (loose.type === "plan_updated") {
        plan = planProgressOf(loose.plan) ?? plan;
        return;
      }
      switch (event.type) {
        case "turn_started":
          begin();
          return;
        case "step_started":
          begin();
          return;
        case "step_finished":
          steps = Math.max(steps + 1, event.stepIndex + 1);
          return;
        case "loop_completed":
        case "loop_failed":
          end();
          return;
        case "llm_event": {
          const inner = event.event;
          if (inner.type === "tool_call_parsed") {
            if (inner.call.tool === "reply" || inner.call.tool === "finish") return;
            current = describe
              ? describe({ name: inner.call.tool, args: inner.call.args }).line
              : `Running ${inner.call.tool}`;
          } else if (inner.type === "tool_call_executed") {
            const result = inner.result;
            if (result.tool === "reply" || result.tool === "finish") return;
            lastResult = describe
              ? {
                  text: describe({
                    name: result.tool,
                    ok: result.status === "ok",
                    ...(result.status === "error" ? { error: "failed" } : {}),
                  }).line,
                  ok: result.status === "ok",
                }
              : describeResult(result);
            current = null;
            blockedOn = null;
          }
          return;
        }
        default:
          return;
      }
    },
    setBlockedOn(tool) {
      blockedOn = tool;
    },
    state() {
      return {
        running,
        startedAt,
        endedAt,
        steps,
        plan,
        current,
        lastResult,
        blockedOn,
      };
    },
  };
}

/**
 * The last result in stable words: a recognised test run says whether
 * the tests passed, any other shell command its exit code, any other
 * tool its name and verdict. Never the output itself.
 */
export function describeResult(result: CompressedToolResult): {
  text: string;
  ok: boolean;
} {
  const ok = result.status === "ok";
  if (result.tool === "os.shell.run") {
    const details = result.details;
    const exit =
      typeof details.exitCode === "number" ? details.exitCode : null;
    const passed = ok && (exit === null || exit === 0);
    let isTest = false;
    try {
      isTest =
        classifyTestCommand(
          "os.shell.run",
          { cmd: details.cmd, args: details.args },
          ".",
        ) !== null;
    } catch {
      isTest = false;
    }
    if (isTest) {
      return passed
        ? { text: "tests passed", ok: true }
        : { text: `tests failed${exit === null ? "" : ` (exit ${exit})`}`, ok: false };
    }
    if (details.timedOut === true) {
      return { text: "os.shell.run · timed out", ok: false };
    }
    return {
      text: exit === null ? `os.shell.run · ${ok ? "ok" : "failed"}` : `os.shell.run · exit ${exit}`,
      ok: passed,
    };
  }
  return { text: `${result.tool} · ${ok ? "ok" : "failed"}`, ok };
}

/**
 * `planProgress` of a structural plan snapshot (ATO-486): done items,
 * total items, and the step in progress. `null` for anything that is
 * not shaped like one.
 */
export function planProgressOf(plan: unknown): PlanProgressLike | null {
  if (typeof plan !== "object" || plan === null) return null;
  const items = (plan as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return null;
  let done = 0;
  let current: string | undefined;
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const { status, step } = item as { status?: unknown; step?: unknown };
    if (status === "done") done += 1;
    else if (status === "in_progress" && current === undefined && typeof step === "string") {
      current = step;
    }
  }
  return current === undefined
    ? { done, total: items.length }
    : { done, total: items.length, current };
}

// ---------------------------------------------------------------------------
// Auto snapshot cadence.
// ---------------------------------------------------------------------------

/** `0` turns a trigger off; both `0` turns auto snapshots off. */
export interface SnapshotCadenceConfig {
  everySteps: number;
  everyMs: number;
}

export const DEFAULT_SNAPSHOT_CADENCE: SnapshotCadenceConfig = {
  everySteps: 10,
  everyMs: 5 * 60_000,
};

export interface SnapshotCadence {
  readonly enabled: boolean;
  /**
   * A snapshot is due: `everySteps` more steps, or `everyMs` more time,
   * since the last one (or since the start, for the first). A turn
   * shorter than both never gets one.
   */
  due(steps: number, now: number): boolean;
  /** A snapshot went out at `steps` / `now`. */
  mark(steps: number, now: number): void;
  /** How often a timer should look (the time trigger alone can fire then). */
  readonly pollMs: number | null;
}

export function createSnapshotCadence(
  config: SnapshotCadenceConfig | null | undefined,
  startedAt: number,
): SnapshotCadence {
  const everySteps = Math.max(0, Math.floor(config?.everySteps ?? 0));
  const everyMs = Math.max(0, Math.floor(config?.everyMs ?? 0));
  const enabled = everySteps > 0 || everyMs > 0;
  let lastSteps = 0;
  let lastAt = startedAt;
  return {
    enabled,
    pollMs: everyMs > 0 ? Math.min(everyMs, 30_000) : null,
    due(steps, now) {
      if (!enabled) return false;
      if (everySteps > 0 && steps - lastSteps >= everySteps) return true;
      if (everyMs > 0 && now - lastAt >= everyMs) return true;
      return false;
    },
    mark(steps, now) {
      lastSteps = steps;
      lastAt = now;
    },
  };
}

function clipOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}
