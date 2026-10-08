import { createHash } from "node:crypto";
import type { PromptTurn } from "../llm/provider/completion-types.js";
import type { ConversationTurn } from "./conversation-turn.js";
import { compactionBoundaryHash } from "./session-compaction.js";

export interface CloudContextEntry {
  id: string;
  /** Exclusive transcript boundary at which this message became available. */
  through: number;
  turn: PromptTurn;
  key?: string;
  digest?: string;
  active?: boolean;
}

export interface CloudContext {
  version: 1;
  turnsThrough: number;
  boundaryHash: string | null;
  entries: CloudContextEntry[];
}

/** Pure candidate; runtime commits it before inference. Preview never writes. */
export function extendCloudContext(
  previous: CloudContext | undefined,
  turns: readonly ConversationTurn[],
  sections: ReadonlyMap<string, string>,
): CloudContext {
  if (previous && (previous.version !== 1 || !Array.isArray(previous.entries) ||
      !Number.isInteger(previous.turnsThrough) || previous.turnsThrough < 0 || previous.turnsThrough > turns.length ||
      previous.entries.some((entry) => !entry || typeof entry.id !== "string" || !Number.isInteger(entry.through) ||
        entry.through < 0 || entry.through > previous.turnsThrough || !entry.turn ||
        !["user", "assistant_reply", "assistant_tool_call", "tool_result"].includes(entry.turn.kind)) ||
      (previous.turnsThrough > 0 && previous.boundaryHash !== compactionBoundaryHash(turns[previous.turnsThrough - 1]!)))) {
    throw new Error("Cloud context does not match the append-only session transcript.");
  }
  const entries = [...(previous?.entries ?? [])];
  let pending: Array<{ id: string; tool: string }> = [];
  const answer = (tool: string): string | undefined => {
    const index = pending.findIndex(call => call.tool === tool);
    return index < 0 ? undefined : pending.splice(index, 1)[0]!.id;
  };
  // Recover pending imported calls without tying their ids to a packed index.
  for (const entry of entries) {
    if (!entry.id.startsWith("turn:")) continue;
    if (entry.turn.kind === "assistant_tool_call") pending.push({ id: entry.turn.callId!, tool: entry.turn.tool });
    else if (entry.turn.kind === "tool_result") answer(entry.turn.tool);
    else pending = [];
  }
  for (let i = previous?.turnsThrough ?? 0; i < turns.length; i++) {
    const source = turns[i]!;
    let turn: PromptTurn;
    switch (source.kind) {
      case "user": pending = []; turn = { kind: "user", text: source.text }; break;
      case "assistant_reply":
        pending = [];
        turn = { kind: "assistant_reply", text: source.attachments?.length
          ? `${source.text} (attached: ${source.attachments.join(", ")})` : source.text };
        break;
      case "assistant_tool_call": {
        const callId = `call_turn_${i}`;
        pending.push({ id: callId, tool: source.tool });
        turn = { kind: source.kind, tool: source.tool, args: structuredClone(source.args), callId };
        break;
      }
      case "tool_result":
        turn = { kind: source.kind, tool: source.tool, status: source.status, body: source.summary,
          truncated: source.truncated === true, callId: answer(source.tool) };
        break;
    }
    entries.push({ id: `turn:${i}`, through: i + 1, turn });
  }
  const latest = new Map<string, CloudContextEntry>();
  for (const entry of entries) if (entry.key) latest.set(entry.key, entry);
  const keys = new Set([...latest.keys(), ...sections.keys()]);
  for (const key of keys) {
    const body = sections.get(key);
    const active = body !== undefined;
    const digest = createHash("sha256").update(body ?? "").digest("hex");
    const old = latest.get(key);
    if ((!old && !active) || (old?.digest === digest && old.active === active)) continue;
    // A full skill/tool load is already a message; tag its new result instead of duplicating its body.
    const matching = (key.startsWith("skill:") || key.startsWith("tool:")) && active
      ? entries.findIndex((entry, i) => i >= (previous?.entries.length ?? 0) && entry.turn.kind === "tool_result" && entry.turn.body === body)
      : -1;
    if (matching >= 0) {
      entries[matching] = { ...entries[matching]!, key, digest, active };
      continue;
    }
    const id = `state:${entries.length}`;
    const text = `### ${key}\nContext update ${id}${old ? `; supersedes ${old.id}` : ""}.\n${body ?? "(no longer active)"}`;
    entries.push({ id, key, digest, active, through: turns.length, turn: { kind: "user", text } });
  }
  if (previous && entries.length === previous.entries.length && previous.turnsThrough === turns.length) return previous;
  return { version: 1, turnsThrough: turns.length,
    boundaryHash: turns.length ? compactionBoundaryHash(turns[turns.length - 1]!) : null, entries };
}

/** Carry full active instructions/state across a checkpoint, then the unchanged suffix. */
export function cloudContextEntries(context: CloudContext, offset: number): CloudContextEntry[] {
  if (!offset) return context.entries;
  const latest = new Map<string, CloudContextEntry>();
  for (const entry of context.entries) if (entry.key && entry.through <= offset) latest.set(entry.key, entry);
  return [...latest.values()].filter((entry) => entry.active).map((entry) => entry.turn.kind === "tool_result"
    ? { ...entry, turn: { kind: "user" as const, text: `### ${entry.key}\nActive context retained from ${entry.id}:\n${entry.turn.body}` } } : entry)
    .concat(context.entries.filter((entry) => entry.through > offset));
}

export function renderCloudTurn(turn: PromptTurn): string {
  switch (turn.kind) {
    case "user": return `user: ${turn.text}`;
    case "assistant_reply": return `assistant: ${turn.text}`;
    case "assistant_tool_call": return `assistant_tool_call: ${turn.tool} ${JSON.stringify(turn.args)}`;
    case "tool_result": return `tool_result[${turn.tool}] (${turn.status}): ${turn.body}${turn.truncated ? " (truncated at source)" : ""}`;
  }
}
