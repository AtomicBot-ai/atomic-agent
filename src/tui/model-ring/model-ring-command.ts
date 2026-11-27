import { parseModelRingEntry, type ModelRingEntry } from "./model-ring.js";

/**
 * `/model favorite …` (ATO-2169), parsed. Pure, so the slash parser can
 * import it; model-ring-actions.ts runs it from the submit path.
 */
export type ModelRingCommand =
  | { kind: "list" }
  | { kind: "clear" }
  | { kind: "add" | "remove"; entry: ModelRingEntry | null };

export const MODEL_RING_USAGE =
  "usage: /model favorite [add|remove [provider/model]] | /model favorite clear";

/** The words after `/model favorite`; null when they are not a command. */
export function parseModelRingCommand(args: string): ModelRingCommand | null {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const verb = (words[0] ?? "list").toLowerCase();
  if (words.length <= 1 && (verb === "list" || verb === "clear")) return { kind: verb };
  if ((verb === "add" || verb === "remove") && words.length <= 2) {
    if (words.length === 1) return { kind: verb, entry: null };
    const entry = parseModelRingEntry(words[1] ?? "");
    return entry ? { kind: verb, entry } : null;
  }
  return null;
}
