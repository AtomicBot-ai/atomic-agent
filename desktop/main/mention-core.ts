/**
 * ATO-2472: the composer's `@` mentions are expanded by the agent, with the
 * same code the terminal runs (src/mentions/ in core): `@file`, `@diff`,
 * `@git:N`, `@path:10-40`, `@folder/`, `@https://...` and `@problems`. Main
 * sends the last user message's text and the chat folder to
 * `POST /api/mentions/expand` and puts back what comes back.
 *
 * An agent from before the route, or one that does not answer, gets the
 * plain file mentions read here (file-mentions.ts), so a message is never
 * sent with less than it had before ATO-2241.
 */

import { expandLastUserMessage } from "./file-mentions.js";

/** The agent's expansion of `text` in `workingDir`, or `null` when it has none or failed. */
export type ExpandInCore = (text: string, workingDir: string) => Promise<string | null>;

export async function expandLastUserMessageViaCore<T extends { role: string; content: string }>(
  messages: readonly T[],
  folder: string | null,
  expandInCore: ExpandInCore,
): Promise<T[]> {
  const out = [...messages];
  const last = out[out.length - 1];
  if (!folder || !last || last.role !== "user" || !last.content.includes("@")) return out;
  let content: string | null = null;
  try {
    content = await expandInCore(last.content, folder);
  } catch {
    content = null;
  }
  if (content === null) return expandLastUserMessage(messages, folder);
  if (content !== last.content) out[out.length - 1] = { ...last, content };
  return out;
}
