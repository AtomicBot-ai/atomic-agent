import { estimateTokens } from "../prompt/token-budget.js";
import type { ConversationTurn } from "../session/conversation-turn.js";
import type { CloudContextEntry } from "../session/cloud-context.js";

/** Keep the owning tool call identifiable when a large result spans requests. */
export function prepareCompactionSource(turns: readonly ConversationTurn[], from: number, through: number, contextEntries: readonly CloudContextEntry[] = []) {
  const pending: Array<{ index: number; turn: Extract<ConversationTurn, { kind: "assistant_tool_call" }> }> = [];
  const records: Array<{ text: string; context: string; end: number }> = [];
  let length = 0;
  for (let index = 0; index < through; index++) {
    const turn = turns[index]!;
    let call: (typeof pending)[number] | undefined;
    if (turn.kind === "assistant_tool_call") {
      call = { index, turn };
      pending.push(call);
    } else if (turn.kind === "tool_result") {
      const match = pending.findIndex((entry) => entry.turn.tool === turn.tool);
      if (match >= 0) [call] = pending.splice(match, 1);
    }
    if (index < from) continue;
    const text = `Record ${index}: ${JSON.stringify(turn)}`;
    const identity = call ? Object.fromEntries(Object.entries(call.turn.args)
      .filter(([key, value]) => ["path", "filePath", "url"].includes(key) && typeof value === "string")) : undefined;
    const context = JSON.stringify({ record: index, kind: turn.kind,
      ...("tool" in turn ? { tool: turn.tool } : {}),
      ...(call ? { toolCallRecord: call.index, sourceIdentity: identity } : {}),
    });
    length += text.length + (records.length ? 1 : 0);
    records.push({ text, context, end: length });
    for (const entry of contextEntries) {
      if (!entry.key || !entry.id.startsWith("state:") || entry.through !== index + 1) continue;
      const update = `Context record ${entry.id}: ${JSON.stringify(entry.turn)}`;
      length += update.length + 1;
      records.push({ text: update, context: JSON.stringify({ record: entry.id, section: entry.key }), end: length });
    }
  }
  return {
    text: records.map((record) => record.text).join("\n"),
    maxContextTokens: records.reduce((largest, record) => Math.max(largest, estimateTokens(record.context)), 0),
    contextAt: (cursor: number) => records.find((record) => cursor < record.end)?.context ?? "",
  };
}

/** Lossless source slices, independent of generation and previous-summary length. */
export function planCompactionChunks(source: string, maxTokens: number): Array<{ start: number; end: number }> {
  if (maxTokens < 128) throw new Error("Context window or input budget is too small for a compaction request.");
  const chunks: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < source.length) {
    let take = Math.min(source.length - start, Math.floor(maxTokens * 3));
    while (take > 0 && estimateTokens(source.slice(start, start + take)) > maxTokens) take = Math.floor(take * 0.8);
    // Do not split a UTF-16 surrogate pair between model requests.
    const last = source.charCodeAt(start + take - 1);
    if (last >= 0xd800 && last <= 0xdbff) take--;
    if (!take) throw new Error("No room for conversation records.");
    chunks.push({ start, end: start + take });
    start += take;
  }
  return chunks;
}
