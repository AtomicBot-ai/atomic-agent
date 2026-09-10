import type { OpenclawBlock, OpenclawMessage } from "./openclaw-source.js";

/**
 * Pure parsing of OpenClaw's event-sourced session logs — one JSON event
 * per line — into the neutral message shape. No I/O; `openclaw-source.ts`
 * owns the files and calls these per line.
 */
export interface OpenclawRawEvent {
  type?: string;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  modelId?: unknown;
  message?: unknown;
}

export function splitLogLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Parse one JSONL line; malformed or blank lines yield null (skipped). */
export function parseLogLine(line: string): OpenclawRawEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed as OpenclawRawEvent;
    return null;
  } catch {
    return null;
  }
}

/** Project a raw `message` event into a neutral `OpenclawMessage`. */
export function projectLogMessage(
  event: OpenclawRawEvent,
): OpenclawMessage | null {
  const msg = event.message;
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const role = m.role;
  if (role !== "user" && role !== "assistant" && role !== "toolResult") {
    return null;
  }
  const blocks = projectBlocks(m.content);
  const atMs =
    typeof m.timestamp === "number"
      ? Math.round(m.timestamp)
      : (isoToMs(event.timestamp) ?? 0);
  return {
    role,
    blocks,
    toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : null,
    toolName: typeof m.toolName === "string" ? m.toolName : null,
    isError: m.isError === true,
    atMs,
  };
}

function projectBlocks(content: unknown): OpenclawBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: OpenclawBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text });
        }
        break;
      case "thinking":
        if (typeof block.thinking === "string") {
          blocks.push({ type: "thinking", thinking: block.thinking });
        }
        break;
      case "toolCall": {
        const name = block.name;
        if (typeof name !== "string" || name.length === 0) break;
        blocks.push({
          type: "toolCall",
          id: typeof block.id === "string" ? block.id : null,
          name,
          args:
            block.arguments &&
            typeof block.arguments === "object" &&
            !Array.isArray(block.arguments)
              ? (block.arguments as Record<string, unknown>)
              : {},
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/** Parse an ISO-8601 timestamp into integer ms; null on failure. */
export function isoToMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
