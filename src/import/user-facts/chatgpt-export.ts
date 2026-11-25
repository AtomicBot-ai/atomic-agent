import type { ExportChat, ExportChatMessage } from "./collect-user-messages.js";

/**
 * ATO-1620. The smallest reader of a ChatGPT data export's
 * `conversations.json` this feature needs: the messages on each chat's
 * visible branch, as {@link ExportChat}. Importing ChatGPT chats as
 * sessions is ATO-588's job; when it lands with a full reader, this one
 * should be replaced by an adapter over it.
 *
 * Shape (Settings › Data controls › Export data, the `.zip` holds
 * `conversations.json`): an array of
 * `{id | conversation_id, title, create_time (epoch seconds), current_node,
 *   mapping: {[nodeId]: {id, parent, children, message: {author: {role},
 *   create_time, content: {content_type, parts: (string | object)[]},
 *   metadata: {is_visually_hidden_from_conversation?}} | null}}}`.
 *
 * A chat is a tree: every edit or regenerate forks it. Only the branch
 * the person last saw (walk `parent` up from `current_node`) is read, so
 * an abandoned edit is not taken as something they said. Hidden
 * messages (custom instructions, system context) and non-text parts
 * (images, code-interpreter output) are skipped.
 */
export function parseChatGptConversations(raw: unknown): ExportChat[] {
  if (!Array.isArray(raw)) return [];
  const out: ExportChat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const id = str(c.conversation_id) ?? str(c.id);
    if (!id) continue;
    const mapping =
      c.mapping && typeof c.mapping === "object" && !Array.isArray(c.mapping)
        ? (c.mapping as Record<string, unknown>)
        : null;
    if (!mapping) continue;
    const chatMs = secondsToMs(c.create_time) ?? 0;
    const branch = visibleBranch(mapping, str(c.current_node));
    const messages: ExportChatMessage[] = [];
    for (const node of branch) {
      const m = projectMessage(node, chatMs);
      if (m) messages.push(m);
    }
    out.push({ id, messages });
  }
  return out;
}

/** Nodes from the root to `currentNode`, or the longest first-child path when it is missing. */
function visibleBranch(mapping: Record<string, unknown>, currentNode: string | null): unknown[] {
  const nodeOf = (key: string | null): Record<string, unknown> | null => {
    if (!key) return null;
    const n = mapping[key];
    return n && typeof n === "object" ? (n as Record<string, unknown>) : null;
  };
  let tip = nodeOf(currentNode);
  if (!tip) {
    // Older exports may lack `current_node`: follow first children from the root.
    const root = Object.values(mapping).find(
      (n) => n && typeof n === "object" && !(n as Record<string, unknown>).parent,
    ) as Record<string, unknown> | undefined;
    const path: unknown[] = [];
    const seen = new Set<unknown>();
    let node: Record<string, unknown> | null = root ?? null;
    while (node && !seen.has(node)) {
      seen.add(node);
      path.push(node);
      const kids = Array.isArray(node.children) ? node.children : [];
      node = nodeOf(typeof kids[0] === "string" ? kids[0] : null);
    }
    return path;
  }
  const path: unknown[] = [];
  const seen = new Set<unknown>();
  while (tip && !seen.has(tip)) {
    seen.add(tip);
    path.push(tip);
    tip = nodeOf(str(tip.parent));
  }
  return path.reverse();
}

function projectMessage(node: unknown, fallbackMs: number): ExportChatMessage | null {
  if (!node || typeof node !== "object") return null;
  const msg = (node as Record<string, unknown>).message;
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const author = m.author && typeof m.author === "object" ? (m.author as Record<string, unknown>) : {};
  const role = author.role === "user" ? "user" : author.role === "assistant" ? "assistant" : null;
  if (!role) return null;
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : {};
  if (meta.is_visually_hidden_from_conversation === true) return null;
  const content = m.content && typeof m.content === "object" ? (m.content as Record<string, unknown>) : {};
  const type = content.content_type;
  if (type !== "text" && type !== "multimodal_text") return null;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = parts.filter((p): p is string => typeof p === "string").join("\n").trim();
  if (!text) return null;
  return { role, text, atMs: secondsToMs(m.create_time) ?? fallbackMs };
}

function secondsToMs(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
