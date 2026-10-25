import type { AgentLoopEvent } from "../agent/agent-contract.js";
import type { SlowFirstTokenHint } from "./slow-first-token-hint.js";

/**
 * What a running turn is doing right now, told to an HTTP host
 * (ATO-1027).
 *
 * On a local model the first message used to show nothing for minutes —
 * the model loading, then the whole prompt being read — and a third of
 * those turns were stopped before any text came. The TUI has its own
 * readouts; an HTTP host had only silence. This tracker turns the
 * events the loop already emits into one `turn_phase` frame per change,
 * so the host can say "Loading model · 34 s", "Reading context · 12 s",
 * "Thinking", "Running a command" and count the seconds itself
 * (`phase_elapsed_ms` is where the count starts).
 *
 * Phases:
 *  - `starting` — the turn was accepted; nothing has reached the model.
 *  - `loading_model` — the local server answered "Loading model" and the
 *    turn waits for it (`provider_waiting`, cause `loading`).
 *  - `waiting_provider` — any other provider wait (`provider_waiting`).
 *  - `processing_prompt` — a request is out and no output has come back:
 *    the prompt is being read. `progress` when the server reports it.
 *  - `thinking` — reasoning is streaming.
 *  - `generating` — the reply or a tool call is being written.
 *  - `running_tool` — a tool call is running (`tool` names it).
 *  - `compacting` — the context is being compacted before a request.
 *
 * And once per turn, a `slow_first_token` frame when a local model has
 * produced nothing at all `slowFirstTokenMs` after the turn began,
 * carrying what the host could offer instead (`buildSlowFirstTokenHint`).
 * A suggestion only: nothing is switched.
 *
 * Extensions-only, like every atomic frame: the caller creates a tracker
 * only for a stream that opted in.
 */

export type TurnPhase =
  | "starting"
  | "loading_model"
  | "waiting_provider"
  | "processing_prompt"
  | "thinking"
  | "generating"
  | "running_tool"
  | "compacting";

/** Default wait for the first token before the hint, in ms. */
export const SLOW_FIRST_TOKEN_MS = 45_000;

export interface TurnPhaseTrackerDeps {
  sessionId: string;
  /** Writes one named extension frame. */
  write(name: string, payload: Record<string, unknown>): void;
  now?: () => number;
  /** Arms a one-shot timer; returns its cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** `null` turns the hint off. */
  slowFirstTokenMs?: number | null;
  /**
   * What to offer when the first token is late, read when the hint is
   * due. `null` when the turn is not on a local model: no hint then.
   */
  slowFirstTokenHint?: () => SlowFirstTokenHint | null;
}

export interface TurnPhaseTracker {
  /** The turn was accepted: `starting`, and the first-token clock runs. */
  start(): void;
  onEvent(event: AgentLoopEvent): void;
  /** The turn is over: the hint timer goes, nothing more is written. */
  dispose(): void;
}

interface Progress {
  processed: number;
  total: number;
  cached: number;
}

export function createTurnPhaseTracker(deps: TurnPhaseTrackerDeps): TurnPhaseTracker {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;
  const slowMs = deps.slowFirstTokenMs === undefined ? SLOW_FIRST_TOKEN_MS : deps.slowFirstTokenMs;
  let turnStartedAt = 0;
  let phase: TurnPhase | null = null;
  let phaseStartedAt = 0;
  let tool: string | undefined;
  let stepIndex: number | undefined;
  let progress: Progress | undefined;
  let batchTools: string[] = [];
  let firstOutput = false;
  let cancelHint: (() => void) | null = null;
  let disposed = false;

  const emit = (): void => {
    if (disposed || phase === null) return;
    const at = now();
    deps.write("turn_phase", {
      object: "atomic.turn_phase",
      session_id: deps.sessionId,
      phase,
      ...(stepIndex !== undefined ? { step_index: stepIndex } : {}),
      ...(tool !== undefined ? { tool } : {}),
      phase_elapsed_ms: Math.max(0, at - phaseStartedAt),
      turn_elapsed_ms: Math.max(0, at - turnStartedAt),
      ...(progress !== undefined
        ? {
            progress: {
              processed: progress.processed,
              total: progress.total,
              cached: progress.cached,
              fraction: Math.round((progress.processed / progress.total) * 1000) / 1000,
            },
          }
        : {}),
    });
  };

  const enter = (next: TurnPhase, nextTool?: string): void => {
    if (next === phase && nextTool === tool) return;
    phase = next;
    tool = nextTool;
    progress = undefined;
    phaseStartedAt = now();
    emit();
  };

  /* The final `reply` is the answer being written, not a command. */
  const enterTool = (name: string): void => {
    if (name === "reply") enter("generating");
    else enter("running_tool", name);
  };

  const outputStarted = (): void => {
    firstOutput = true;
    cancelHint?.();
    cancelHint = null;
  };

  const fireHint = (): void => {
    cancelHint = null;
    if (disposed || firstOutput || !deps.slowFirstTokenHint) return;
    let hint: SlowFirstTokenHint | null = null;
    try {
      hint = deps.slowFirstTokenHint();
    } catch {
      hint = null;
    }
    if (hint === null) return;
    deps.write("slow_first_token", {
      object: "atomic.slow_first_token",
      session_id: deps.sessionId,
      waited_ms: Math.max(0, now() - turnStartedAt),
      ...(phase !== null ? { phase } : {}),
      ...(hint.modelId !== null ? { model_id: hint.modelId } : {}),
      ...(hint.lighterModel !== null
        ? {
            lighter_model: {
              id: hint.lighterModel.id,
              name: hint.lighterModel.name,
              file_size_gb: hint.lighterModel.fileSizeGb,
            },
          }
        : {}),
      cloud_available: hint.cloudAvailable,
    });
  };

  const onStepEvent = (inner: Extract<AgentLoopEvent, { type: "llm_event" }>["event"]): void => {
    switch (inner.type) {
      case "prompt_progress": {
        // Only ever before a completion's first token: the prompt is
        // being read, whatever the phase said. One frame per change.
        stepIndex = inner.stepIndex;
        if (phase !== "processing_prompt" || tool !== undefined) {
          phase = "processing_prompt";
          tool = undefined;
          phaseStartedAt = now();
        } else if (progress?.processed === inner.processed && progress.total === inner.total) {
          return;
        }
        progress = { processed: inner.processed, total: inner.total, cached: inner.cached };
        emit();
        return;
      }
      case "first_token":
        // Told after the chunk's own deltas: a reasoning start has
        // already made this `thinking`, which it stays.
        outputStarted();
        stepIndex = inner.stepIndex;
        if (phase !== "thinking" && phase !== "generating") enter("generating");
        return;
      case "reasoning_delta":
        if (inner.text.length === 0) return;
        outputStarted();
        enter("thinking");
        return;
      case "assistant_delta":
        if (inner.text.length === 0) return;
        outputStarted();
        enter("generating");
        return;
      case "tool_call_parsed":
        // A batch is parsed whole before its first call runs: the phase
        // names the call that runs, not the last one parsed.
        outputStarted();
        batchTools[inner.batchIndex] = inner.call.tool;
        if (inner.batchIndex === 0) enterTool(inner.call.tool);
        return;
      case "tool_call_executed": {
        // The batch is done: what follows is the next request.
        if (inner.batchIndex >= inner.batchSize - 1) {
          batchTools = [];
          enter("processing_prompt");
          return;
        }
        const next = batchTools[inner.batchIndex + 1];
        if (next !== undefined) enterTool(next);
        return;
      }
      default:
        return;
    }
  };

  return {
    start() {
      if (disposed || phase !== null) return;
      turnStartedAt = now();
      enter("starting");
      if (slowMs !== null && slowMs > 0 && deps.slowFirstTokenHint) {
        cancelHint = schedule(fireHint, slowMs);
      }
    },
    onEvent(event) {
      if (disposed || phase === null) return;
      switch (event.type) {
        case "step_started":
          stepIndex = event.stepIndex;
          enter("processing_prompt");
          return;
        case "llm_event":
          onStepEvent(event.event);
          return;
        case "provider_waiting":
          enter(event.cause?.kind === "loading" ? "loading_model" : "waiting_provider");
          return;
        case "provider_recovered":
          enter("processing_prompt");
          return;
        case "compaction_started":
          if (event.sessionId === deps.sessionId) enter("compacting");
          return;
        case "compaction_completed":
        case "compaction_failed":
          if (event.sessionId === deps.sessionId && phase === "compacting") enter("processing_prompt");
          return;
        default:
          return;
      }
    },
    dispose() {
      disposed = true;
      cancelHint?.();
      cancelHint = null;
    },
  };
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  // A turn's hint must never keep the process alive.
  timer.unref?.();
  return () => clearTimeout(timer);
}
