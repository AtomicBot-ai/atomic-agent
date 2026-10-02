import {
  sameRouteLeg,
  sameSessionRoute,
  type RouteLeg,
  type SessionRoute,
} from "../session/session-route.js";

/**
 * What the model on the new route can do, as far as the runtime knows.
 * `null` is "unknown" and is said as such. One field today; the shape
 * is an object so a per-model answer (vision resolved per model rather
 * than per provider) can fill it without touching the renderer.
 */
export interface RouteCapabilities {
  vision: boolean | null;
}

/**
 * The `### route` note for the first turn after the serving route
 * changed, or `null` when it did not. Factual and short: the new route,
 * the old one, what the new model can do, and that limitations the old
 * model stated no longer bind — the transcript is otherwise the only
 * place the model learns who it is, and it names the old model.
 */
export function renderRouteChangeNote(
  previous: SessionRoute,
  next: SessionRoute,
  capabilities: RouteCapabilities,
): string | null {
  if (sameSessionRoute(previous, next)) return null;
  const parts: string[] = [];
  parts.push(
    sameRouteLeg(previous.main, next.main)
      ? `[route changed] You are still running as ${legLabel(next.main)}.`
      : `[route changed] You are now running as ${legLabel(next.main)} (previously ${legLabel(previous.main)}).`,
  );
  if (previous.mode !== next.mode) {
    parts.push(`Run mode: ${next.mode} (previously ${previous.mode}).`);
  }
  if (next.worker !== null && !sameRouteLeg(previous.worker, next.worker)) {
    parts.push(
      `Fusion workers now run as ${legLabel(next.worker)} (previously ${
        previous.worker === null ? "none" : legLabel(previous.worker)
      }).`,
    );
  }
  parts.push(`Capabilities now: reads images: ${yesNo(capabilities.vision)}.`);
  parts.push(
    "Tool refusals and limitations stated earlier in this conversation that were tied to the previous model no longer apply — re-check by calling the tool.",
  );
  return parts.join(" ");
}

function legLabel(leg: RouteLeg): string {
  return leg.model === null
    ? leg.providerId
    : `${leg.model} on ${leg.providerId}`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return "unknown";
  return value ? "yes" : "no";
}
