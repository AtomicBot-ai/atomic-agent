/**
 * One stored chat as one line of a chat fine-tuning file (ATO-1104):
 * `{"messages":[{"role":"user","content":…},{"role":"assistant","content":…},…]}`,
 * the shape OpenAI, Together, Unsloth and most trainers read.
 *
 * Built from `SessionStore.listChatLines`, so only what the person typed
 * and the agent's closing answers go in. Tool calls, tool output and
 * progress notes are never read. Messages the person sent in a row (a
 * steer while the agent was working) are joined into one user message,
 * as are answers in a row, so roles alternate the way trainers expect. A
 * chat opens on a user message and closes on an answer: a leading answer
 * and a trailing question with no reply are dropped, and a chat with no
 * answer at all gives no record.
 */

import type { SessionChatLine } from "../session-store.js";

export interface DatasetMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DatasetRecord {
  messages: DatasetMessage[];
}

export function buildDatasetRecord(
  lines: readonly SessionChatLine[],
  scrub: (text: string) => string,
): DatasetRecord | null {
  const messages: DatasetMessage[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const role = line.kind === "user" ? "user" : "assistant";
    const last = messages.at(-1);
    if (last?.role === role) {
      last.content = `${last.content}\n\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }
  while (messages.length > 0 && messages[0]!.role !== "user") messages.shift();
  while (messages.length > 0 && messages.at(-1)!.role !== "assistant") messages.pop();
  if (messages.length < 2) return null;
  // Only the messages that are written get scrubbed, so the counts the
  // command prints match the file.
  for (const message of messages) message.content = scrub(message.content);
  return { messages };
}
