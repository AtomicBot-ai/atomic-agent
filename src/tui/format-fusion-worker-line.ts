import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { FeedEntry } from "./tui-state.js";

type FusionWorkerEvent = Extract<AgentLoopEvent, { type: "fusion_worker" }>;

/**
 * The feed line for one leg of a fusion turn.
 *
 * Fusion divides a single turn between two models on two bills, and a
 * worker's own steps are tagged with a session the TUI reducer drops —
 * so without an explicit name on every line the operator sees a wall of
 * activity with no way to tell the cloud orchestrator's work from the
 * local workers'. Each line therefore leads with *who*: `worker <task>`
 * or `orchestrator`, then `· <model>` whenever the runtime actually
 * knows which model that leg runs on.
 *
 * The model is never synthesised here. `undefined` means the resolver
 * had no label and no provider id to fall back to, and the line simply
 * omits it — a wrong model name is worse than none, because the whole
 * point of the attribution is where the tokens went.
 *
 * Lines stay short because the feed truncates: one clause for the
 * subject, one for what happened.
 */
export function formatFusionWorkerLine(event: FusionWorkerEvent): string {
  const model = event.model ? ` · ${event.model}` : "";
  const who =
    event.role === "orchestrator"
      ? `orchestrator${model}`
      : `worker ${event.title}${model}`;
  switch (event.phase) {
    case "started":
      return `» ${who}: started`;
    case "tool":
      // The orchestrator's only line is its own `fusion.delegate` call,
      // and its `title` carries the fan-out width — worth the columns.
      return event.role === "orchestrator"
        ? `» ${who} — ${event.tool ?? "working"} (${event.title})`
        : `» ${who} — ${event.tool ?? "working"}`;
    case "cancelled":
      return `» ${who}: cancelled`;
    case "failed":
      return `» ${who}: failed — ${event.summary ?? "no detail"}`;
    case "finished": {
      // The orchestrator has no step count of its own to report here —
      // it is mid-turn, not finished — so its line carries only the
      // fan-out summary.
      const steps =
        event.stepCount === undefined ? "" : ` — ${event.stepCount} steps`;
      const detail =
        event.summary === undefined
          ? ""
          : `${steps === "" ? " — " : ", "}${event.summary}`;
      return `» ${who}: done${steps}${detail}`;
    }
    default: {
      // A new phase must be rendered deliberately, not silently swallowed
      // into the gray "started" branch.
      const unhandled: never = event.phase;
      void unhandled;
      return `» ${who}`;
    }
  }
}

/** Colour semantics, unchanged from the event's first shape. */
export function fusionWorkerLineColor(
  event: FusionWorkerEvent,
): FeedEntry["color"] {
  if (event.phase === "failed") return "red";
  if (event.phase === "cancelled") return "yellow";
  if (event.phase === "finished") return "green";
  return "gray";
}
